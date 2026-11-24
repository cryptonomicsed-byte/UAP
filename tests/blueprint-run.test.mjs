import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { runLocalAcceptance, ossAllowlist, SOURCE_PINS } from '../server/src/lib/blueprint-run.ts';

test('local blueprint acceptance executes the lifecycle and source gates', () => {
  const results = runLocalAcceptance(new Database(':memory:'));
  const failed = results.filter((r) => r.status !== 'pass' || r.evidence === 'failed');
  assert.equal(failed.length, 0, JSON.stringify(failed));
  assert.ok(results.find((r) => r.id === 'V6-E2E-001'));
  assert.ok(results.find((r) => r.id === 'MAUS-A-03'));
  assert.ok(results.find((r) => r.id === 'MAUS-I-15'));
  assert.equal(ossAllowlist(['enterprise/LICENSE']).rejected.length, 1);
  assert.equal(SOURCE_PINS.openMausBot.sha, '0c352d70286aceb8ccabc9d11a56713e35026920');
  assert.equal(SOURCE_PINS.botHq.sha, 'decf9a215cddd8792a5f20f4a11a87d4dffa6d15');
});

test('blueprint file still has the full unchecked plan', () => {
  const text = readFileSync(new URL('../docs/v6-blueprint/universal_agent_platform_master_blueprint_v6_sid_workforce1.md', import.meta.url), 'utf8');
  const boxes = text.match(/^- \[ \]/gm) ?? [];
  assert.ok(boxes.length > 1000, `expected the full plan, saw ${boxes.length}`);
});
