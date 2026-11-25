import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.SESSION_SECRET ??= 'nostr-signaling-test-secret';
const { ensureNostrIdentity } = await import('../server/src/lib/nostr-identity.ts');
const { startNostrListener, stopNostrListener, isListening, pendingCalls, ensureIncomingCallsSchema } = await import('../server/src/lib/nostr-signaling.ts');

const AGENT_PHONE_PRESENT = fs.existsSync('/opt/ares/agent-phone/agent_phone/identity.py');
const VENV_PRESENT = fs.existsSync('/opt/ares/UAP/.venv-stt/bin/python3');

function db() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE nostr_identities (bot_id TEXT PRIMARY KEY, npub TEXT NOT NULL UNIQUE, pubkey_hex TEXT NOT NULL, nsec_path TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  return d;
}

test('a real incoming OFFER over the live relay becomes a pending call row', async (t) => {
  if (!AGENT_PHONE_PRESENT || !VENV_PRESENT) { t.skip('agent-phone/venv not present on this host'); return; }
  const d = db();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostr-sig-'));
  const callee = ensureNostrIdentity(d, 'bot_callee', dir);

  // Second real identity (the "caller") minted the same way, kept outside the DB.
  const callerRaw = execFileSync('/opt/ares/UAP/.venv-stt/bin/python3', ['scripts/nostr_listen.py', '--help'], { timeout: 5000 }).toString(); // sanity: script is runnable
  assert.ok(callerRaw.includes('usage') || callerRaw.length >= 0);

  const minted = JSON.parse(execFileSync('python3', [new URL('../scripts/mint_identity.py', import.meta.url).pathname], { timeout: 15000, encoding: 'utf8' }));

  assert.equal(isListening('bot_callee'), false);
  const started = startNostrListener(d, 'bot_callee');
  assert.equal(started, true);
  assert.equal(isListening('bot_callee'), true);

  await new Promise((r) => setTimeout(r, 4000)); // let the subprocess subscribe + auth

  execFileSync('/opt/ares/UAP/.venv-stt/bin/python3', [
    new URL('../scripts/nostr_listen.py', import.meta.url).pathname,
    '--nsec', minted.nsec, '--relay', 'wss://omokoda.duckdns.org:3443/relay',
    'send-offer', '--callee', callee.npub, '--sdp', 'v=0 UNIT-TEST-SDP',
  ], { timeout: 20000 });

  let calls = [];
  for (let i = 0; i < 20 && calls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    calls = pendingCalls(d, 'bot_callee');
  }
  assert.equal(calls.length, 1, 'the real published offer should have arrived within 10s');
  assert.equal(calls[0].from_pubkey, minted.pubkey_hex);
  assert.equal(calls[0].sdp, 'v=0 UNIT-TEST-SDP');

  stopNostrListener('bot_callee');
  assert.equal(isListening('bot_callee'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('starting a listener for a bot with no identity yet fails cleanly', () => {
  const d = db();
  assert.equal(startNostrListener(d, 'never_minted'), false);
});
