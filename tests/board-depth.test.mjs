import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('board and depth are wired: real elevation + blur only on real overlays', () => {
  const main = readFileSync(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
  assert.match(main, /depth\.css/);
  const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /BoardView/);
  const sidebar = readFileSync(new URL('../web/src/components/Sidebar.tsx', import.meta.url), 'utf8');
  assert.match(sidebar, /BoardIsland/);
  const depth = readFileSync(new URL('../web/src/styles/depth.css', import.meta.url), 'utf8');
  assert.doesNotMatch(depth, /backdrop-filter[^;]*;\s*\}\s*\n\s*\*/); // no stray unscoped blur rule
  assert.match(depth, /prefers-reduced-motion: no-preference/);
  assert.match(depth, /--elevation-1/);
});
