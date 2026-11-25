import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('workspace rail absorbs the five layout surfaces', () => {
  const rail = readFileSync(new URL('../web/src/components/WorkspaceRail.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
  for (const id of ['chat', 'templates', 'computer', 'board', 'market', 'live', 'design', 'domain', 'operator']) {
    assert.match(rail, new RegExp(`id: '${id}'`));
  }
  assert.match(app, /WorkspaceRail/);
  assert.match(app, /WorkspaceStage/);
  assert.match(css, /workspace.css/);
  assert.match(rail, /Nod:/);
  assert.match(rail, /not imported/);
});
