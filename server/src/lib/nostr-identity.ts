/**
 * Real Nostr identity (NIP-06-rooted npub) for every SID agent, minted by shelling out to
 * the user's own, already-tested agent-phone/minipae Python code (scripts/mint_identity.py) —
 * never reimplemented crypto in TypeScript. This is the identity root agent-phone's own
 * NOSTR_INTEGRATION.md describes: "npub -> { nip05?, suins?, sui_address?, reticulum_hash }".
 * The secret key (nsec) never touches the database or an API response — it is written once
 * to a 0600 file under this bot's private home and only the file path is recorded.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

const SCRIPT = new URL('../../../scripts/mint_identity.py', import.meta.url).pathname;

export interface NostrIdentity { bot_id: string; npub: string; pubkey_hex: string; nsec_path: string; created_at: number }

export class NostrIdentityError extends Error {}

/** Mints a fresh identity if this bot doesn't have one yet; otherwise returns the existing one.
 *  secretsDir should be a private, non-web-served directory (the bot's managed home). */
export function ensureNostrIdentity(db: Database.Database, botId: string, secretsDir: string): NostrIdentity {
  const existing = db.prepare('SELECT * FROM nostr_identities WHERE bot_id=?').get(botId) as NostrIdentity | undefined;
  if (existing) return existing;

  let raw: string;
  try {
    raw = execFileSync('python3', [SCRIPT], { timeout: 15_000, encoding: 'utf8' });
  } catch (e: any) {
    throw new NostrIdentityError(`Could not mint a Nostr identity (is agent-phone/minipae installed on this host?): ${e?.message ?? e}`);
  }
  const minted = JSON.parse(raw.trim()) as { npub: string; nsec: string; pubkey_hex: string };

  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const nsecPath = path.join(secretsDir, 'nostr.nsec');
  fs.writeFileSync(nsecPath, minted.nsec + '\n', { mode: 0o600 });

  const now = Date.now();
  db.prepare('INSERT INTO nostr_identities(bot_id,npub,pubkey_hex,nsec_path,created_at) VALUES (?,?,?,?,?)')
    .run(botId, minted.npub, minted.pubkey_hex, nsecPath, now);
  return { bot_id: botId, npub: minted.npub, pubkey_hex: minted.pubkey_hex, nsec_path: nsecPath, created_at: now };
}

export function nostrIdentityFor(db: Database.Database, botId: string): NostrIdentity | null {
  return (db.prepare('SELECT * FROM nostr_identities WHERE bot_id=?').get(botId) as NostrIdentity | undefined) ?? null;
}
