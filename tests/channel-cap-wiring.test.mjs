import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('enqueue() gates new turns on the channel cap before a storm reaches the engine', () => {
  const src = readFileSync(new URL('../server/src/agent/loop.ts', import.meta.url), 'utf8');
  assert.match(src, /recordAndCheckChannelCap/);
  assert.match(src, /channel_rate_limited/);
  // The cap must sit before the turn is queued, not after — otherwise it limits nothing.
  const enqueueIdx = src.indexOf('export function enqueue(');
  const capIdx = src.indexOf('recordAndCheckChannelCap', enqueueIdx);
  const queueSetIdx = src.indexOf('queues.set(botId, next)', enqueueIdx);
  assert.ok(capIdx > -1 && capIdx < queueSetIdx, 'the cap check must run before the turn is queued');
  // A system trigger (internal, not a user/bot flood) must never be capped.
  assert.match(src, /trigger\.type !== 'system'/);
});
