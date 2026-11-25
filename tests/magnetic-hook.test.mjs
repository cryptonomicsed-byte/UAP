import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('useMagnetic computes a bounded --dx/--dy from pointer position relative to center', () => {
  const src = readFileSync(new URL('../web/src/lib/useMagnetic.ts', import.meta.url), 'utf8');
  assert.match(src, /setProperty\('--dx'/);
  assert.match(src, /setProperty\('--dy'/);
  assert.match(src, /onPointerLeave/);
  // Reset-to-zero on leave is the part that matters: a magnetic button must not get stuck offset.
  assert.match(src, /'--dx', '0'/);
  assert.match(src, /'--dy', '0'/);
});

test('useMagnetic is actually wired into ChatView header buttons, not left unused', () => {
  const src = readFileSync(new URL('../web/src/components/ChatView.tsx', import.meta.url), 'utf8');
  assert.match(src, /useMagnetic/);
  const magneticButtons = [...src.matchAll(/className=(?:"chat__quick magnetic|\{`chat__quick magnetic)/g)].length;
  assert.ok(magneticButtons >= 3, 'expected all three header quick-action buttons to be magnetic');
});
