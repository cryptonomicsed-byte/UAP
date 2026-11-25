import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('operate rail + mobile shell files exist', () => {
  for (const rel of [
    'web/src/components/OperateRail.tsx',
    'web/src/styles/operate.css',
    'web/src/styles/mobile.css',
  ]) {
    assert.ok(existsSync(path.join(root, rel)), rel);
  }
});

test('main imports operate + mobile + config css', () => {
  const main = readFileSync(path.join(root, 'web/src/main.tsx'), 'utf8');
  assert.match(main, /operate\.css/);
  assert.match(main, /mobile\.css/);
  assert.match(main, /config\.css/);
});

test('DetailsPanel defaults to the agent desk', () => {
  const src = readFileSync(path.join(root, 'web/src/components/DetailsPanel.tsx'), 'utf8');
  assert.match(src, /useState<'operate' \| 'activity'/);
  assert.match(src, /AgentDesk/);
  assert.match(src, />Desk</);
});

test('ChatView exposes Computer Voice Agent quick actions', () => {
  const src = readFileSync(path.join(root, 'web/src/components/ChatView.tsx'), 'utf8');
  assert.match(src, /Computer/);
  assert.match(src, /Voice/);
  assert.match(src, />\s*Agent\s*</);
  assert.match(src, /onToggleNav/);
});

test('App wires mobile nav + scrim', () => {
  const src = readFileSync(path.join(root, 'web/src/App.tsx'), 'utf8');
  assert.match(src, /is-nav-open/);
  assert.match(src, /shell__scrim/);
  assert.match(src, /onToggleNav/);
});

test('routes-v6 exposes /operate-surface', () => {
  const src = readFileSync(path.join(root, 'server/src/routes-v6.ts'), 'utf8');
  assert.match(src, /\/operate-surface/);
  assert.match(src, /listAllToolCatalog/);
});

test('mobile css targets max-width 900 drawer + sheet', () => {
  const css = readFileSync(path.join(root, 'web/src/styles/mobile.css'), 'utf8');
  assert.match(css, /max-width:\s*900px/);
  assert.match(css, /\.app\.is-nav-open/);
  assert.match(css, /\.details/);
});
