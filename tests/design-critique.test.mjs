import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  scoreCritique,
  evaluateReleaseNogo,
  assertReleaseAllowed,
  CRITIQUE_PASS_AVERAGE,
  RUBRIC,
} from '../server/src/lib/design-critique.ts';

const root = path.resolve(import.meta.dirname, '..');

test('J-35 rubric covers seven dimensions', () => {
  assert.equal(Object.keys(RUBRIC).length, 7);
});

test('J-35 scoreCritique blocks low average and low dimension', () => {
  const low = scoreCritique([
    { dimension: 'hierarchy', score: 4, notes: '' },
    { dimension: 'consistency', score: 4, notes: '' },
    { dimension: 'accessibility', score: 1, notes: 'bad focus' },
    { dimension: 'motion', score: 4, notes: '' },
    { dimension: 'density', score: 4, notes: '' },
    { dimension: 'honesty', score: 4, notes: '' },
    { dimension: 'distinctiveness', score: 4, notes: '' },
  ]);
  assert.ok(low.blockers.includes('dimension_floor:accessibility'));

  const mid = scoreCritique(
    Object.keys(RUBRIC).map((d) => ({ dimension: d, score: 3, notes: '' })),
  );
  assert.ok(mid.average < CRITIQUE_PASS_AVERAGE);
  assert.ok(mid.blockers.includes('average_below_pass'));
});

test('J-35 UAP with strong critique scores and design gates passes', () => {
  const scores = Object.keys(RUBRIC).map((d) => ({
    dimension: d,
    score: 4,
    notes: 'calibrated pass',
  }));
  const report = evaluateReleaseNogo({ projectRoot: root, critiqueScores: scores });
  assert.equal(report.designGates.nogo, false);
  assert.equal(report.nogo, false);
  assert.equal(report.pass, true);
  assert.doesNotThrow(() => assertReleaseAllowed(report));
});

test('J-35 missing critique is NO-GO even if DESIGN.md ok', () => {
  const report = evaluateReleaseNogo({ projectRoot: root });
  assert.ok(report.blockers.includes('critique_missing'));
  assert.equal(report.nogo, true);
  assert.throws(() => assertReleaseAllowed(report), (e) => e.code === 'release_nogo');
});

test('J-35 requireUiQa without manifest is NO-GO', () => {
  const scores = Object.keys(RUBRIC).map((d) => ({ dimension: d, score: 5, notes: '' }));
  const report = evaluateReleaseNogo({
    projectRoot: root,
    critiqueScores: scores,
    requireUiQa: true,
    uiQaManifestPath: path.join(root, 'tests/out/ui-qa/manifest-missing.json'),
  });
  assert.ok(report.blockers.includes('ui_qa_manifest_missing'));
  assert.equal(report.nogo, true);
});
