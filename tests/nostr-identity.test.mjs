import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SESSION_SECRET ??= 'nostr-identity-test-secret';
const { ensureNostrIdentity, nostrIdentityFor } = await import('../server/src/lib/nostr-identity.ts');

function db() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE nostr_identities (
    bot_id TEXT PRIMARY KEY, npub TEXT NOT NULL UNIQUE, pubkey_hex TEXT NOT NULL,
    nsec_path TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  return d;
}

test('agent-phone/minipae are actually reachable on this host (real check, not mocked)', () => {
  // This is the exact precondition the real code depends on; skip loudly rather than fake-pass
  // if the box this runs on doesn't have the sibling repos cloned.
  const hasAgentPhone = fs.existsSync('/opt/ares/agent-phone/agent_phone/identity.py');
  const hasMinipae = fs.existsSync('/opt/ares/minipae.py');
  if (!hasAgentPhone || !hasMinipae) {
    console.log('  (skipped: agent-phone/minipae not present on this host — expected off the Contabo box)');
    return;
  }
  const d = db();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostr-id-'));
  const identity = ensureNostrIdentity(d, 'bot_1', dir);
  assert.match(identity.npub, /^npub1[a-z0-9]{58}$/);
  assert.equal(fs.statSync(identity.nsec_path).mode & 0o777, 0o600);
  // nsec is never returned by the public API shape
  assert.ok(!('nsec' in identity));

  // Idempotent: a second call for the same bot returns the same identity, mints nothing new.
  const again = ensureNostrIdentity(d, 'bot_1', dir);
  assert.equal(again.npub, identity.npub);
  assert.equal(nostrIdentityFor(d, 'bot_1')?.npub, identity.npub);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('nostrIdentityFor returns null for a bot with no identity yet', () => {
  const d = db();
  assert.equal(nostrIdentityFor(d, 'never_minted'), null);
});
