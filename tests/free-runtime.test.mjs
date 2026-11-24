import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRuntime, assertNoPaidFallback, LOCAL_CONNECTORS, LOCAL_VOICES } from '../server/src/lib/free-runtime.ts';

test('free runtime never selects paid providers when keys are absent', () => {
  const choice = selectRuntime({ localBox: true, orgoConfigured: false, xaiConfigured: false, composioConfigured: false });
  assert.equal(choice.computer, 'local');
  assert.equal(choice.voice, 'local');
  assert.equal(choice.connectors, 'local');
  assert.equal(choice.paidFallback, false);
  assert.doesNotThrow(() => assertNoPaidFallback(choice, 'computer'));
  assert.ok(LOCAL_VOICES.length >= 1);
  assert.ok(LOCAL_CONNECTORS.some((c) => c.slug === 'local-shell'));
});

test('paid providers are explicit upgrades, not silent fallbacks', () => {
  const choice = selectRuntime({ localBox: false, orgoConfigured: true, xaiConfigured: true, composioConfigured: true });
  assert.equal(choice.computer, 'orgo');
  assert.equal(choice.voice, 'xai');
  assert.equal(choice.connectors, 'composio');
  assert.equal(choice.paidFallback, false);
});

test('no local box and no Orgo is unavailable, not a paid guess', () => {
  const choice = selectRuntime({ localBox: false, orgoConfigured: false, xaiConfigured: false, composioConfigured: false });
  assert.equal(choice.computer, 'unavailable');
  assert.throws(() => assertNoPaidFallback(choice, 'computer'), /HQ_LOCAL/);
});
