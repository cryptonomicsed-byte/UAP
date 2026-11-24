import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAllLanguageConformance, runLanguageConformance } from '../server/src/lib/language-conformance.ts';

test('H-28 per-language conformance for all seven languages', () => {
  const all = runAllLanguageConformance();
  assert.equal(all.reports.length, 7);
  assert.equal(all.ok, true, JSON.stringify(all.reports.filter((r) => !r.ok)));
  for (const r of all.reports) {
    assert.ok(r.checkIds.length >= 2);
    assert.equal(r.dryRunPass, false);
    assert.equal(r.claimWithoutEvidenceAccepted, false);
  }
  assert.equal(runLanguageConformance('rust').ok, true);
});
