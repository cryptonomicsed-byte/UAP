/**
 * Manages one long-running scripts/nostr_listen.py "listen" subprocess per bot (its own
 * Nostr identity, from nostr-identity.ts), parses its NDJSON stdout, and turns a decoded
 * "offer" signal into a real incoming-call row + a live hub event the UI can show.
 *
 * This is the signaling half of the numberless call system proven this session: a real
 * offer, gift-wrapped and NIP-42-authenticated, published by one identity on the live
 * ares-buzz-relay and decrypted by another. The media/audio layer (actual WebRTC) is
 * still separate and not built here -- this only gets an incoming call to show up.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import readline from 'node:readline';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { nostrIdentityFor } from './nostr-identity.js';

const SCRIPT = new URL('../../../scripts/nostr_listen.py', import.meta.url).pathname;
const RELAY_URL = process.env.AGENT_PHONE_RELAY ?? 'wss://omokoda.duckdns.org:3443/relay';
const VENV_PYTHON = '/opt/ares/UAP/.venv-stt/bin/python3';

export function ensureIncomingCallsSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS incoming_calls (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, call_id TEXT NOT NULL, from_pubkey TEXT,
    sdp TEXT, status TEXT NOT NULL DEFAULT 'ringing', created_at INTEGER NOT NULL
  );`);
}

interface Listener { botId: string; proc: ChildProcessByStdio<null, Readable, Readable> }
const listeners = new Map<string, Listener>();

export function startNostrListener(db: Database.Database, botId: string, onSignal?: (botId: string, msg: any) => void): boolean {
  if (listeners.has(botId)) return false;
  const identity = nostrIdentityFor(db, botId);
  if (!identity) return false;
  const nsec = fs.readFileSync(identity.nsec_path, 'utf8').trim();

  const proc = spawn(VENV_PYTHON, [SCRIPT, '--nsec', nsec, '--relay', RELAY_URL, 'listen', '--timeout-s', '86400'], { stdio: ['ignore', 'pipe', 'pipe'] });
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === 'signal' && msg.signal_type === 'offer') {
      ensureIncomingCallsSchema(db);
      db.prepare('INSERT INTO incoming_calls(id,bot_id,call_id,from_pubkey,sdp,status,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(`call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, botId, msg.signal.call_id, msg.from_pubkey ?? null, msg.signal.sdp ?? null, 'ringing', Date.now());
    }
    onSignal?.(botId, msg);
  });
  proc.on('exit', () => listeners.delete(botId));
  proc.stderr.on('data', () => {}); // swallowed; a crash just shows as "offline" via listeners.delete above
  listeners.set(botId, { botId, proc });
  return true;
}

export function stopNostrListener(botId: string): boolean {
  const l = listeners.get(botId);
  if (!l) return false;
  l.proc.kill();
  listeners.delete(botId);
  return true;
}

export function isListening(botId: string): boolean {
  return listeners.has(botId);
}

export function pendingCalls(db: Database.Database, botId: string) {
  ensureIncomingCallsSchema(db);
  return db.prepare("SELECT * FROM incoming_calls WHERE bot_id=? AND status='ringing' ORDER BY created_at DESC").all(botId);
}
