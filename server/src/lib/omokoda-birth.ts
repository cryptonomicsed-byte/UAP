/**
 * Omokoda guest birth, owned by UAP.
 *
 * UAP calls the Omokoda kernel's /v1/birth (non-sovereign path: a new guest agent on the
 * shared kernel process), mints a SID for it from the `omokoda-guest` template, and
 * optionally registers the same agent with Vantage.
 *
 * Secrets: the kernel's agent_key and Vantage's api_key are written to 0600 files under
 * the key directory. They never enter the database, the SID document, a log line or an
 * API response. Reads return presence only.
 *
 * Genesis: the kernel birth payload is reduced to a SHA-256 hash (genesis_hash) that is
 * stored beside the birth row. Folding it into the SID certificate is the next step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { materializeSidBot } from './sid-bots.js';

export type OmokodaBirthCode =
  | 'name'
  | 'kernel-unreachable'
  | 'kernel-rejected'
  | 'kernel-malformed'
  | 'sid';

export class OmokodaBirthError extends Error {
  constructor(
    readonly code: OmokodaBirthCode,
    message: string,
    readonly kernelAgentId: string | null = null,
  ) {
    super(message);
  }
}

export interface OmokodaBirthResult {
  botId: string;
  sid: string;
  kernelAgentId: string;
  genesisHash: string;
  keyStored: boolean;
  vantage: VantageRegistration;
}

export type VantageRegistration =
  | { status: 'skipped'; reason: string }
  | { status: 'registered'; vantageAgentId: string | null }
  | { status: 'failed'; reason: string };

const KERNEL_TIMEOUT_MS = 15_000;

function kernelUrl(): string {
  return (process.env.OMOKODA_URL || 'http://127.0.0.1:7778').replace(/\/+$/, '');
}

function keyDir(): string {
  return process.env.OMOKODA_KEY_DIR || new URL('../../../data/omokoda-keys/', import.meta.url).pathname;
}

export function ensureOmokodaSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS omokoda_births (
      bot_id TEXT PRIMARY KEY,
      sid TEXT NOT NULL,
      kernel_agent_id TEXT NOT NULL,
      kernel_url TEXT NOT NULL,
      genesis_hash TEXT NOT NULL,
      vantage_agent_id TEXT,
      vantage_status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

/** Deterministic JSON: sorted keys at every level, no whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Hash of the kernel birth facts. The secret key is excluded before hashing. */
export function genesisHashOf(name: string, kernelAgentId: string, birth: Record<string, unknown>): string {
  const { agent_key: _secret, ...facts } = birth;
  return createHash('sha256').update(canonical({ name, kernel_agent_id: kernelAgentId, birth: facts })).digest('hex');
}

function writeSecret(botId: string, suffix: 'omokoda' | 'vantage', value: string): void {
  const dir = keyDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${botId}.${suffix}.key`), `${value}\n`, { mode: 0o600 });
}

export function secretPresence(botId: string): { omokoda: boolean; vantage: boolean } {
  const dir = keyDir();
  return {
    omokoda: fs.existsSync(path.join(dir, `${botId}.omokoda.key`)),
    vantage: fs.existsSync(path.join(dir, `${botId}.vantage.key`)),
  };
}

/** Birth a guest on the Omokoda kernel and mint its SID. Vantage registration is separate. */
export async function birthOmokodaGuest(
  db: Database.Database,
  input: { userId: string; name: string; source?: string },
): Promise<{ botId: string; sid: string; kernelAgentId: string; genesisHash: string; keyStored: boolean }> {
  ensureOmokodaSchema(db);
  const name = input.name.trim();
  if (!name || name.length > 64) throw new OmokodaBirthError('name', 'name must be 1-64 characters');

  const url = kernelUrl();
  let res: Response;
  try {
    res = await fetch(`${url}/v1/birth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        meta: [
          { key: 'owner', value: input.userId },
          { key: 'source', value: input.source || 'uap' },
        ],
      }),
      signal: AbortSignal.timeout(KERNEL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OmokodaBirthError('kernel-unreachable', `kernel unreachable: ${(error as Error).message}`);
  }
  if (!res.ok) {
    throw new OmokodaBirthError('kernel-rejected', `kernel refused birth (HTTP ${res.status})`);
  }

  const birth = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const kernelAgentId = birth && typeof birth.agent_id === 'string' ? birth.agent_id : null;
  const agentKey = birth && typeof birth.agent_key === 'string' ? birth.agent_key : null;
  if (!birth || !kernelAgentId || !agentKey) {
    throw new OmokodaBirthError('kernel-malformed', 'kernel birth response lacks agent_id or agent_key');
  }

  let made: ReturnType<typeof materializeSidBot>;
  try {
    made = materializeSidBot(db, { userId: input.userId, template: 'omokoda-guest' });
  } catch (error) {
    throw new OmokodaBirthError('sid', `SID mint failed: ${(error as Error).message}`, kernelAgentId);
  }

  writeSecret(made.botId, 'omokoda', agentKey);
  const genesisHash = genesisHashOf(name, kernelAgentId, birth);
  db.prepare(
    'INSERT INTO omokoda_births(bot_id,sid,kernel_agent_id,kernel_url,genesis_hash,vantage_agent_id,vantage_status,created_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(made.botId, made.sid, kernelAgentId, url, genesisHash, null, 'pending', Date.now());

  return { botId: made.botId, sid: made.sid, kernelAgentId, genesisHash, keyStored: true };
}

/** Register a birthed agent with Vantage. Failure is reported, never thrown: the birth stands. */
export async function registerWithVantage(
  db: Database.Database,
  botId: string,
  input: { name: string; bio: string },
): Promise<VantageRegistration> {
  ensureOmokodaSchema(db);
  const base = (process.env.VANTAGE_URL || '').replace(/\/+$/, '');
  if (!base) {
    db.prepare('UPDATE omokoda_births SET vantage_status=? WHERE bot_id=?').run('skipped', botId);
    return { status: 'skipped', reason: 'VANTAGE_URL not set' };
  }
  let registration: VantageRegistration;
  try {
    const res = await fetch(`${base}/api/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: input.name, bio: input.bio }),
      signal: AbortSignal.timeout(KERNEL_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !body || typeof body.api_key !== 'string') {
      registration = { status: 'failed', reason: `Vantage refused registration (HTTP ${res.status})` };
    } else {
      writeSecret(botId, 'vantage', body.api_key);
      const vantageAgentId = body.agent_id != null ? String(body.agent_id) : body.id != null ? String(body.id) : null;
      registration = { status: 'registered', vantageAgentId };
    }
  } catch (error) {
    registration = { status: 'failed', reason: `Vantage unreachable: ${(error as Error).message}` };
  }
  const vantageAgentId = registration.status === 'registered' ? registration.vantageAgentId : null;
  db.prepare('UPDATE omokoda_births SET vantage_status=?, vantage_agent_id=? WHERE bot_id=?')
    .run(registration.status, vantageAgentId, botId);
  return registration;
}

/** Birth + optional Vantage registration, the single entry point for routes and tools. */
export async function birthAndRegister(
  db: Database.Database,
  input: { userId: string; name: string; bio?: string; register?: boolean },
): Promise<OmokodaBirthResult> {
  const born = await birthOmokodaGuest(db, { userId: input.userId, name: input.name });
  let vantage: VantageRegistration;
  if (input.register === false) {
    db.prepare('UPDATE omokoda_births SET vantage_status=? WHERE bot_id=?').run('skipped', born.botId);
    vantage = { status: 'skipped', reason: 'registration disabled' };
  } else {
    vantage = await registerWithVantage(db, born.botId, {
      name: input.name,
      bio: input.bio || 'Ọmọ Kọ́dà agent born through UAP',
    });
  }
  return { ...born, vantage };
}

/** Presence-only read of a birth. Never returns a key value. */
export function getOmokodaBirth(db: Database.Database, botId: string) {
  ensureOmokodaSchema(db);
  const row = db.prepare(
    'SELECT bot_id, sid, kernel_agent_id, kernel_url, genesis_hash, vantage_agent_id, vantage_status, created_at FROM omokoda_births WHERE bot_id=?',
  ).get(botId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { ...row, secrets: secretPresence(botId) };
}
