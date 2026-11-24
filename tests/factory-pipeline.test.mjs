import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createFactoryJob,
  smithersBuild,
  skillforgeAttachPack,
  reaEvaluate,
  assertFactoryPromoteAllowed,
  attemptPromoteWithoutRea,
} from '../server/src/lib/factory-pipeline.ts';

const src = createHash('sha256').update('src').digest('hex');

test('P-46 happy path smithers → skillforge → rea → promote', () => {
  let job = createFactoryJob('proj-a');
  job = smithersBuild(job, { projectId: 'proj-a', sourceHash: src, languageGatePackId: 'rust' });
  assert.equal(job.stage, 'skillforge_pack');
  assert.ok(job.artifactHash);
  job = skillforgeAttachPack(job, { id: 'pack-rust-tools', version: '1.0.0' });
  assert.equal(job.stage, 'rea_eval');
  job = reaEvaluate(job, {
    artifactHash: job.artifactHash,
    suiteId: 'rea-core',
    score: 0.91,
    findings: [],
  });
  assert.equal(job.stage, 'promote');
  assert.doesNotThrow(() => assertFactoryPromoteAllowed(job));
});

test('P-46 cannot skip REA', () => {
  let job = createFactoryJob('p');
  job = smithersBuild(job, { projectId: 'p', sourceHash: src });
  job = skillforgeAttachPack(job, { id: 'x', version: '1' });
  assert.throws(() => attemptPromoteWithoutRea(job), (e) => e.code === 'factory_rea_required');
  assert.throws(() => assertFactoryPromoteAllowed(job), (e) => e.code === 'factory_promote_denied');
});

test('P-46 REA below threshold rejects', () => {
  let job = createFactoryJob('p');
  job = smithersBuild(job, { projectId: 'p', sourceHash: src });
  job = skillforgeAttachPack(job, { id: 'x', version: '1' });
  job = reaEvaluate(job, {
    artifactHash: job.artifactHash,
    suiteId: 'rea',
    score: 0.5,
    findings: [],
  });
  assert.equal(job.stage, 'reject');
  assert.ok(job.blockers.includes('rea_below_threshold'));
});

test('P-46 REA critical finding rejects even with high score', () => {
  let job = createFactoryJob('p');
  job = smithersBuild(job, { projectId: 'p', sourceHash: src });
  job = skillforgeAttachPack(job, { id: 'x', version: '1' });
  job = reaEvaluate(job, {
    artifactHash: job.artifactHash,
    suiteId: 'rea',
    score: 0.99,
    findings: ['critical:auth-bypass'],
  });
  assert.equal(job.stage, 'reject');
  assert.ok(job.blockers.includes('rea_critical_finding'));
});

test('P-46 stage order enforced', () => {
  const job = createFactoryJob('p');
  assert.throws(
    () => skillforgeAttachPack(job, { id: 'x', version: '1' }),
    (e) => e.code === 'factory_stage_invalid',
  );
});

test('P-46 artifact mismatch on REA rejects', () => {
  let job = createFactoryJob('p');
  job = smithersBuild(job, { projectId: 'p', sourceHash: src });
  job = skillforgeAttachPack(job, { id: 'x', version: '1' });
  job = reaEvaluate(job, {
    artifactHash: '0'.repeat(64),
    suiteId: 'rea',
    score: 1,
    findings: [],
  });
  assert.equal(job.stage, 'reject');
  assert.ok(job.blockers.includes('rea_artifact_mismatch'));
});
