import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localScreenIdFor, LOCAL_SCREEN_IDS } from '../server/src/lib/local-desktop.ts';

test('local desks stop at the three displays that exist', () => {
  assert.deepEqual([...LOCAL_SCREEN_IDS], ['default', 'screen-100', 'screen-101']);
  assert.equal(localScreenIdFor(102), null);
  const computer = readFileSync(new URL('../server/src/computer.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(computer, /screen-102/);
  assert.match(readFileSync(new URL('../server/src/agent/tools.ts', import.meta.url), 'utf8'), /name: 'list_board'/);
  assert.match(readFileSync(new URL('../web/src/components/WorkspaceRail.tsx', import.meta.url), 'utf8'), /id: 'board'/);
});
