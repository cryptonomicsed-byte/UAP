import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('language gate evidence records real tool runs and a blocked clojure', () => {
  const evidence = JSON.parse(readFileSync(new URL('../docs/v6-blueprint/language-gate-evidence.json', import.meta.url), 'utf8'));
  const byId = Object.fromEntries(evidence.runs.map((row) => [row.id, row]));
  for (const id of ['V6-11-01', 'V6-11-02', 'V6-11-03', 'V6-11-04', 'V6-11-05', 'V6-11-06']) {
    assert.equal(byId[id].result, 'pass', id);
  }
  assert.equal(byId['V6-11-07'].result, 'blocked');
  assert.match(byId['V6-11-07'].detail, /not installed/);
});
