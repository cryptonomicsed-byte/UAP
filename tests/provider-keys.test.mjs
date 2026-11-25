import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.SESSION_SECRET ??= 'provider-keys-test-secret';
const { setProviderKey, removeProviderKey, configuredProviders, providerKeyFor, ProviderKeyError } = await import('../server/src/lib/provider-keys.ts');

function db() { return new Database(':memory:'); }

test('setProviderKey stores it, and configuredProviders only ever reports presence', () => {
  const d = db();
  setProviderKey(d, 'user_1', 'anthropic', 'sk-ant-real-secret-value');
  const configured = configuredProviders(d, 'user_1');
  assert.equal(configured.anthropic, true);
  assert.equal(configured.openai, false);
  // The raw secret must never appear in the presence-check response.
  assert.ok(!JSON.stringify(configured).includes('sk-ant-real-secret-value'));
});

test('providerKeyFor is the one real read path and returns the actual value', () => {
  const d = db();
  setProviderKey(d, 'user_1', 'openai', 'sk-openai-real');
  assert.equal(providerKeyFor(d, 'user_1', 'openai'), 'sk-openai-real');
  assert.equal(providerKeyFor(d, 'user_1', 'xai'), null);
  assert.equal(providerKeyFor(d, 'user_2', 'openai'), null, 'keys are per-user, not global');
});

test('rejects an unknown provider and an empty key', () => {
  const d = db();
  assert.throws(() => setProviderKey(d, 'user_1', 'not-a-real-provider', 'x'), ProviderKeyError);
  assert.throws(() => setProviderKey(d, 'user_1', 'anthropic', '   '), ProviderKeyError);
});

test('removeProviderKey deletes it for good', () => {
  const d = db();
  setProviderKey(d, 'user_1', 'google', 'secret');
  removeProviderKey(d, 'user_1', 'google');
  assert.equal(configuredProviders(d, 'user_1').google, false);
  assert.equal(providerKeyFor(d, 'user_1', 'google'), null);
});

test('saving a key again for the same provider overwrites, not duplicates', () => {
  const d = db();
  setProviderKey(d, 'user_1', 'xai', 'first');
  setProviderKey(d, 'user_1', 'xai', 'second');
  assert.equal(providerKeyFor(d, 'user_1', 'xai'), 'second');
  const count = d.prepare('SELECT COUNT(*) AS n FROM user_provider_keys WHERE user_id=? AND provider=?').get('user_1', 'xai');
  assert.equal(count.n, 1);
});
