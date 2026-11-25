import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the relay does not wait on an open event a local socket never fires', () => {
  const src = readFileSync(new URL('../server/src/vnc.ts', import.meta.url), 'utf8');
  // LocalVncUpstream only emits message/close/error. Any unconditional wait on 'open'
  // hangs every local-screen viewer session forever (the bug fixed here).
  assert.doesNotMatch(src, /upstream\.on\('open'/);
  const guard = src.indexOf("readyState !== WebSocket.OPEN");
  const wait = src.indexOf("once('open', () => res())");
  assert.ok(guard > 0 && guard < wait, 'the open-wait must be skipped once the upstream is already connected');
});
