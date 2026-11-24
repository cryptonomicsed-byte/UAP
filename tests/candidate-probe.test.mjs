import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canPromote, classifyProbe } from '../server/src/sources/candidate-probe.ts';

test('candidate probe is complete and none are installable', () => {
  const report = JSON.parse(readFileSync(new URL('../docs/v6-blueprint/candidate-access.json', import.meta.url), 'utf8'));
  assert.equal(report.count, 103);
  assert.equal(report.results.length, 103);
  assert.equal(report.installable, false);
  const classes = { not_found: 0, auth_or_rate: 0, archived: 0, no_license: 0, unverified: 0 };
  for (const row of report.results) {
    assert.equal(row.installable, false);
    assert.equal(row.trust, 'unverified_candidate');
    assert.equal(canPromote(row), false);
    classes[classifyProbe(row)] += 1;
    if (row.access === 'ok') assert.match(row.head_sha, /^[a-f0-9]{40}$/);
  }
  assert.equal(classes.not_found, 0);
  assert.equal(classes.no_license, 16);
  assert.equal(classes.unverified, 87);
});
