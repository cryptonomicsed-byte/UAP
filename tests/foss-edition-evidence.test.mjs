import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('OSS edition evidence records a real boot without enterprise/', () => {
  const evidence = JSON.parse(readFileSync(new URL('../docs/v6-blueprint/foss-edition-evidence.json', import.meta.url), 'utf8'));
  assert.equal(evidence.source.sha, '0c352d70286aceb8ccabc9d11a56713e35026920');
  assert.equal(evidence.source.enterpriseRemoved, true);
  assert.equal(evidence.steps.boot.edition, 'oss');
  assert.match(evidence.steps.boot.notice, /no enterprise layer exists/);
  assert.equal(evidence.steps.vitest.includes('19 passed'), true);
  assert.equal(evidence.steps.hermesDriver.includes('67 passed'), true);
  assert.ok(evidence.notClaimed.length >= 3);
});
