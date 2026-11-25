import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET ??= 'model-catalog-test-secret';
const { modelCatalog, SUPPORTED_PROVIDERS } = await import('../server/src/lib/model-catalog.ts');

test('modelCatalog returns real providers with real models, from the live models.dev API or a safe fallback', async () => {
  const { providers, origin } = await modelCatalog();
  assert.ok(['live', 'cache', 'fallback'].includes(origin));
  assert.ok(providers.length > 0);
  for (const p of providers) {
    assert.ok(SUPPORTED_PROVIDERS.includes(p.id), `${p.id} should be one of the providers we actually wire a key for`);
    assert.ok(p.models.length > 0, `${p.id} should list at least one model`);
    for (const m of p.models) assert.ok(m.id && m.name);
  }
  // Anthropic (or at minimum one well-known provider) must be present either way.
  assert.ok(providers.some((p) => p.id === 'anthropic'));
});

test('the second call is served from the in-process cache, not a second real fetch', async () => {
  const t0 = Date.now();
  await modelCatalog();
  const first = Date.now() - t0;
  const t1 = Date.now();
  const { origin } = await modelCatalog();
  const second = Date.now() - t1;
  assert.equal(origin, 'cache');
  assert.ok(second <= first + 50, 'a cached call should not re-do a real network fetch');
});
