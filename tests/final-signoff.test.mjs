import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { runFinalSignoff } from '../server/src/lib/final-signoff.ts';

const root = path.resolve(import.meta.dirname, '..');

test('FINAL-61 M0-M7 gate signoff + signed release record', () => {
  const s = runFinalSignoff(root, 'final-signoff-test-key', '6.0.0');
  assert.equal(s.ok, true, JSON.stringify(s, null, 2));
  assert.equal(s.e2e.length, 6);
  assert.ok(s.e2e.every((e) => e.pass));
  assert.equal(s.designNogo, false);
  assert.equal(s.languagePacks, 7);
  assert.equal(s.tiers, 5);
  assert.equal(s.releaseBlockers.length, 0);
  assert.equal(s.releaseHash.length, 64);
});
