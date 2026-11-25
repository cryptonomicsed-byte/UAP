import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('a spawned sub-agent delegates its parent autonomy, grants stay empty', () => {
  const src = readFileSync(new URL('../server/src/lib/sid-bots.ts', import.meta.url), 'utf8');
  assert.match(src, /delegateAutonomy/);
  assert.match(src, /does not copy the parent's grants/);
});
