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
 * stored beside the birth row and committed in the SID template certificate provenance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { materializeSidBot } from './sid-bots.js';
import { verifySidLegacy } from '../identity/sid-legacy.js';

export type OmokodaBirthCode =
  | 'name'
  | 'kernel-unreachable'
  | 'kernel-rejected'
  | 'kernel-malformed'
  | 'kernel-not-managed'
  | 'sid'
  | 'request-key'
  | 'birth-conflict'
  | 'birth-unresolved';

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
    CREATE TABLE IF NOT EXISTS omokoda_managed_runtime (
      bot_id TEXT PRIMARY KEY,
      kernel_sid TEXT NOT NULL,
      kernel_sid_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS omokoda_birth_requests (
      user_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, request_key)
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

/** Bind the non-secret birth identifiers, not arbitrary fields from the kernel. */
export function genesisHashOf(name: string, kernelAgentId: string, birth: Record<string, unknown>): string {
  const receiptId = typeof birth.receipt_id === 'string' ? birth.receipt_id : null;
  const doc = birth.sid_document as { hash?: unknown } | undefined;
  const sidHash = typeof doc?.hash === 'string' ? doc.hash : null;
  return createHash('sha256').update(canonical({ name, kernel_agent_id: kernelAgentId, receipt_id: receiptId, kernel_sid_hash: sidHash })).digest('hex');
}

function writeSecret(botId: string, suffix: 'omokoda' | 'vantage', value: string): void {
  const dir = keyDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${botId}.${suffix}.key`), `${value}\n`, { mode: 0o600, flag: 'wx' });
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
  // Never send a birth to an old kernel that still auto-registers and executes.
  const health = await fetch(`${url}/v1/health`, { redirect: 'error', signal: AbortSignal.timeout(4000) })
    .then(async (response) => response.ok ? await response.json() : null).catch(() => null);
  if (!health) throw new OmokodaBirthError('kernel-unreachable', 'kernel did not respond to discovery');
  if (health.uap_managed_birth !== 1) throw new OmokodaBirthError('kernel-not-managed', 'kernel does not support managed guest birth v1');
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
      redirect: 'error',
    });
  } catch {
    throw new OmokodaBirthError('kernel-unreachable', 'kernel did not confirm birth');
  }
  if (!res.ok) {
    throw new OmokodaBirthError('kernel-rejected', `kernel refused birth (HTTP ${res.status})`);
  }

  const birth = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const kernelAgentId = birth && typeof birth.agent_id === 'string' ? birth.agent_id : null;
  const agentKey = birth && typeof birth.agent_key === 'string' ? birth.agent_key : null;
  const native = birth?.sid_document as { id?: string; hash?: string; appendix?: { agent_id?: string } } | undefined;
  if (birth?.managed !== true || !kernelAgentId || !agentKey || agentKey === kernelAgentId ||
      !native?.id || !native.hash || native.appendix?.agent_id !== kernelAgentId || !verifySidLegacy(native).ok) {
    throw new OmokodaBirthError('kernel-malformed', 'kernel did not return a verified managed identity');
  }

  const genesisHash = genesisHashOf(name, kernelAgentId, birth);
  let made: ReturnType<typeof materializeSidBot>;
  try {
    made = materializeSidBot(db, { userId: input.userId, template: 'omokoda-guest', omokodaBirthHash: genesisHash, displayName: name });
  } catch (error) {
    throw new OmokodaBirthError('sid', `SID mint failed: ${(error as Error).message}`, kernelAgentId);
  }

  writeSecret(made.botId, 'omokoda', agentKey);
  db.prepare(
    'INSERT INTO omokoda_births(bot_id,sid,kernel_agent_id,kernel_url,genesis_hash,vantage_agent_id,vantage_status,created_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(made.botId, made.sid, kernelAgentId, url, genesisHash, null, 'pending', Date.now());
  db.prepare('INSERT INTO omokoda_managed_runtime(bot_id,kernel_sid,kernel_sid_hash) VALUES (?,?,?)')
    .run(made.botId, native.id, native.hash);

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
      redirect: 'error',
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !body || typeof body.api_key !== 'string') {
      registration = { status: 'failed', reason: `Vantage refused registration (HTTP ${res.status})` };
    } else {
      writeSecret(botId, 'vantage', body.api_key);
      const vantageAgentId = body.agent_id != null ? String(body.agent_id) : body.id != null ? String(body.id) : null;
      registration = { status: 'registered', vantageAgentId };
    }
  } catch {
    registration = { status: 'failed', reason: 'Vantage registration could not be confirmed' };
  }
  const vantageAgentId = registration.status === 'registered' ? registration.vantageAgentId : null;
  db.prepare('UPDATE omokoda_births SET vantage_status=?, vantage_agent_id=? WHERE bot_id=?')
    .run(registration.status, vantageAgentId, botId);
  return registration;
}

/** Birth + optional Vantage registration, the single entry point for routes and tools. */
export async function birthAndRegister(
  db: Database.Database,
  input: { userId: string; name: string; bio?: string; register?: boolean; requestKey?: string },
): Promise<OmokodaBirthResult> {
  const name = input.name.trim();
  if (!name || name.length > 64) throw new OmokodaBirthError('name', 'name must be 1-64 characters');
  const bio = input.bio || 'Ọmọ Kọ́dà agent born through UAP';
  const register = input.register !== false;
  const { requestKey, userId } = input;
  if (requestKey !== undefined) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestKey)) {
      throw new OmokodaBirthError('request-key', 'Idempotency-Key must be 1–128 letters, digits, dots, underscores, or hyphens');
    }
    ensureOmokodaSchema(db);
    const inputHash = createHash('sha256').update(canonical({ name, register, bio: register ? bio : null })).digest('hex');
    // Reserve before the first await. A missing result is deliberately sticky:
    // a disconnected caller or upstream timeout does not prove no birth occurred.
    const inserted = db.prepare(`INSERT INTO omokoda_birth_requests(user_id,request_key,input_hash,created_at)
      VALUES (?,?,?,?) ON CONFLICT(user_id,request_key) DO NOTHING`).run(userId, requestKey, inputHash, Date.now());
    if (inserted.changes === 0) {
      const prior = db.prepare('SELECT input_hash, result_json FROM omokoda_birth_requests WHERE user_id=? AND request_key=?')
        .get(userId, requestKey) as { input_hash: string; result_json: string | null };
      if (prior.input_hash !== inputHash) throw new OmokodaBirthError('birth-conflict', 'this request key belongs to different birth inputs');
      if (!prior.result_json) throw new OmokodaBirthError('birth-unresolved', 'birth is in progress or unconfirmed; reconcile it before repeating');
      const result = JSON.parse(prior.result_json) as OmokodaBirthResult;
      const owned = getOmokodaBirth(db, result.botId, userId);
      if (!owned) throw new OmokodaBirthError('birth-conflict', 'the original birth is no longer available');
      return result;
    }
  }
  const born = await birthOmokodaGuest(db, { userId, name });
  let vantage: VantageRegistration;
  if (!register) {
    db.prepare('UPDATE omokoda_births SET vantage_status=? WHERE bot_id=?').run('skipped', born.botId);
    vantage = { status: 'skipped', reason: 'registration disabled' };
  } else {
    vantage = await registerWithVantage(db, born.botId, {
      name,
      bio,
    });
  }
  const result = { ...born, vantage };
  if (requestKey !== undefined) {
    db.prepare('UPDATE omokoda_birth_requests SET result_json=? WHERE user_id=? AND request_key=?')
      .run(JSON.stringify(result), userId, requestKey);
  }
  return result;
}

/** Null means a non-Omokoda bot, not a failed managed turn. An old guest must
 * never be silently run as Hermes or promoted to managed by name. */
export async function thinkOmokodaGuest(
  db: Database.Database,
  input: { botId: string; userId: string; prompt: string; signal?: AbortSignal },
): Promise<string | null> {
  ensureOmokodaSchema(db);
  const row = db.prepare(`SELECT b.kernel_agent_id, b.kernel_url, r.kernel_sid
    FROM omokoda_births b JOIN bots ON bots.id=b.bot_id
    LEFT JOIN omokoda_managed_runtime r ON r.bot_id=b.bot_id
    WHERE b.bot_id=? AND bots.user_id=?`).get(input.botId, input.userId) as
    { kernel_agent_id: string; kernel_url: string; kernel_sid: string | null } | undefined;
  if (!row) return null;
  if (!row.kernel_sid || row.kernel_url !== kernelUrl()) throw new Error('Omokoda guest is not bound to the configured managed kernel');
  const key = fs.readFileSync(path.join(keyDir(), `${input.botId}.omokoda.key`), 'utf8').trim();
  const timeout = AbortSignal.timeout(65_000);
  const response = await fetch(`${row.kernel_url}/v1/think`, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-agent-id': row.kernel_agent_id, 'x-agent-key': key },
    body: JSON.stringify({ prompt: input.prompt, agentic: false }),
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`Omokoda cognition failed (HTTP ${response.status})`);
  const reply = await response.json() as { tool_output?: unknown };
  if (typeof reply.tool_output !== 'string' || !reply.tool_output.trim()) throw new Error('Omokoda returned no text');
  return reply.tool_output;
}

/** Presence-only read of a birth. Never returns a key value. */
export function getOmokodaBirth(db: Database.Database, botId: string, userId: string) {
  ensureOmokodaSchema(db);
  const row = db.prepare(
    `SELECT b.bot_id, b.sid, b.kernel_agent_id, b.genesis_hash, b.vantage_agent_id, b.vantage_status, b.created_at,
            r.kernel_sid, r.kernel_sid_hash
     FROM omokoda_births b JOIN bots ON bots.id=b.bot_id
     LEFT JOIN omokoda_managed_runtime r ON r.bot_id=b.bot_id WHERE b.bot_id=? AND bots.user_id=?`,
  ).get(botId, userId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { ...row, secrets: secretPresence(botId) };
}
