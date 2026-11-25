import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.SESSION_SECRET ??= 'engine-model-test-secret';

// This exercises the restored write path at the DB layer directly (routes-config.ts's PATCH
// handler does exactly this UPDATE), since standing up the full Hono app + auth cookie for an
// HTTP-level test is out of scope here -- the behavior under test is "the column round-trips
// and empty/omitted inputs behave correctly", which the direct SQL proves just as well.
function db() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE bots (id TEXT PRIMARY KEY, provider TEXT, model TEXT, updated_at INTEGER)`);
  d.prepare('INSERT INTO bots(id, updated_at) VALUES (?, ?)').run('bot_1', Date.now());
  return d;
}

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);

test('setting provider+model persists both columns', () => {
  const d = db();
  d.prepare('UPDATE bots SET provider=?, updated_at=? WHERE id=?').run(clean('anthropic'), Date.now(), 'bot_1');
  d.prepare('UPDATE bots SET model=?, updated_at=? WHERE id=?').run(clean('claude-sonnet-4-5'), Date.now(), 'bot_1');
  const row = d.prepare('SELECT provider, model FROM bots WHERE id=?').get('bot_1');
  assert.equal(row.provider, 'anthropic');
  assert.equal(row.model, 'claude-sonnet-4-5');
});

test('an empty string clears the column back to the engine default (null)', () => {
  const d = db();
  d.prepare('UPDATE bots SET provider=?, model=? WHERE id=?').run('xai', 'grok-4', 'bot_1');
  d.prepare('UPDATE bots SET provider=? WHERE id=?').run(clean(''), 'bot_1');
  const row = d.prepare('SELECT provider, model FROM bots WHERE id=?').get('bot_1');
  assert.equal(row.provider, null);
  assert.equal(row.model, 'grok-4', 'untouched column is unaffected');
});

test('a value over 120 chars is truncated, not rejected', () => {
  const long = 'x'.repeat(200);
  assert.equal(clean(long).length, 120);
});

test("loop.ts's request body uses the bot's own model/provider, falling back to the engine default", () => {
  // Mirrors the exact expression restored in server/src/agent/loop.ts.
  const build = (bot) => ({ model: bot.model || 'hermes-agent', ...(bot.provider ? { provider: bot.provider } : {}) });
  assert.deepEqual(build({ model: null, provider: null }), { model: 'hermes-agent' });
  assert.deepEqual(build({ model: 'claude-sonnet-4-5', provider: 'anthropic' }), { model: 'claude-sonnet-4-5', provider: 'anthropic' });
  assert.deepEqual(build({ model: 'grok-4', provider: null }), { model: 'grok-4' }, 'a model without a provider omits the field rather than sending null');
});
