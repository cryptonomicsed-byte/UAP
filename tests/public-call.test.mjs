import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.SESSION_SECRET ??= 'public-call-test-secret';
const { ensurePublicCallToken, regeneratePublicCallToken, botIdForPublicToken, publicCallUrl, qrCodeDataUrl } = await import('../server/src/lib/public-call.ts');

function db() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT, avatar_color TEXT, avatar_shape TEXT, public_call_token TEXT)`);
  d.exec(`CREATE UNIQUE INDEX bots_public_call_token ON bots(public_call_token)`);
  d.prepare('INSERT INTO bots(id, name, avatar_color, avatar_shape) VALUES (?,?,?,?)').run('bot_1', 'Rhea', 'violet', 'blob');
  return d;
}

test('ensurePublicCallToken mints a real token, idempotently', () => {
  const d = db();
  const t1 = ensurePublicCallToken(d, 'bot_1');
  const t2 = ensurePublicCallToken(d, 'bot_1');
  assert.equal(t1, t2);
  assert.ok(t1.length >= 20);
});

test('botIdForPublicToken resolves a real bot and rejects a wrong or short token', () => {
  const d = db();
  const token = ensurePublicCallToken(d, 'bot_1');
  const found = botIdForPublicToken(d, token);
  assert.equal(found?.id, 'bot_1');
  assert.equal(found?.name, 'Rhea');
  assert.equal(botIdForPublicToken(d, 'not-a-real-token-at-all'), null);
  assert.equal(botIdForPublicToken(d, ''), null);
});

test('regenerating invalidates the old token', () => {
  const d = db();
  const old = ensurePublicCallToken(d, 'bot_1');
  const fresh = regeneratePublicCallToken(d, 'bot_1');
  assert.notEqual(old, fresh);
  assert.equal(botIdForPublicToken(d, old), null);
  assert.equal(botIdForPublicToken(d, fresh)?.id, 'bot_1');
});

test('publicCallUrl matches the /call/<token> pattern', () => {
  assert.equal(publicCallUrl('abc123', 'https://omokoda.space/'), 'https://omokoda.space/call/abc123');
});

test('qrCodeDataUrl produces a real embeddable PNG data URL', async () => {
  const url = await qrCodeDataUrl('https://omokoda.space/call/abc123');
  assert.match(url, /^data:image\/png;base64,/);
  assert.ok(url.length > 500, 'a real QR PNG is not tiny');
});
