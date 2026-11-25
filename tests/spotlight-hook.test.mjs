import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('useSpotlight is never called inside a .map() callback (rules-of-hooks)', () => {
  const src = readFileSync(new URL('../web/src/components/config/BoardView.tsx', import.meta.url), 'utf8');
  const mapBlocks = [...src.matchAll(/\.map\(\([^)]*\)\s*=>\s*\{[^}]*\}/gs)].map((m) => m[0]);
  for (const block of mapBlocks) {
    assert.doesNotMatch(block, /useSpotlight\(/, 'useSpotlight must not be called directly inside a .map() callback — extract a component');
  }
  // It must still be used, just via a real component.
  assert.match(src, /function BoardCard/);
  assert.match(src, /useSpotlight</);
});

test('useSpotlight resets to zero on pointer leave so a card does not get stuck glowing', () => {
  const src = readFileSync(new URL('../web/src/lib/useSpotlight.ts', import.meta.url), 'utf8');
  assert.match(src, /onPointerLeave.*'--spot-o', '0'/s);
});
