import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { recordAndCheckChannelCap, channelCapStatus } from '../server/src/lib/channel-caps.ts';

function db() { return new Database(':memory:'); }

test('turns under the cap are allowed and counted', () => {
  const d = db();
  for (let i = 0; i < 5; i++) {
    const r = recordAndCheckChannelCap(d, 'ch_a', { windowMs: 60_000, maxTurnsPerWindow: 20 });
    assert.equal(r.allowed, true);
  }
  assert.equal(channelCapStatus(d, 'ch_a', { windowMs: 60_000, maxTurnsPerWindow: 20 }).countInWindow, 5);
});

test('a storm is denied once the cap is hit, with a real retryAfterMs', () => {
  const d = db();
  const cfg = { windowMs: 60_000, maxTurnsPerWindow: 3 };
  for (let i = 0; i < 3; i++) assert.equal(recordAndCheckChannelCap(d, 'ch_b', cfg).allowed, true);
  const denied = recordAndCheckChannelCap(d, 'ch_b', cfg);
  assert.equal(denied.allowed, false);
  assert.equal(denied.countInWindow, 3);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= cfg.windowMs);
});

test('channels are independent — one storm does not cap another channel', () => {
  const d = db();
  const cfg = { windowMs: 60_000, maxTurnsPerWindow: 2 };
  recordAndCheckChannelCap(d, 'ch_storm', cfg);
  recordAndCheckChannelCap(d, 'ch_storm', cfg);
  assert.equal(recordAndCheckChannelCap(d, 'ch_storm', cfg).allowed, false);
  assert.equal(recordAndCheckChannelCap(d, 'ch_quiet', cfg).allowed, true);
});

test('the window actually slides: an old event ages out and frees capacity', async () => {
  const d = db();
  const cfg = { windowMs: 50, maxTurnsPerWindow: 1 };
  assert.equal(recordAndCheckChannelCap(d, 'ch_c', cfg).allowed, true);
  assert.equal(recordAndCheckChannelCap(d, 'ch_c', cfg).allowed, false);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(recordAndCheckChannelCap(d, 'ch_c', cfg).allowed, true);
});
