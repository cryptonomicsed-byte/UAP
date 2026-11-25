import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINEERING_PACK, acceptBuild, dispatchSpecialists, packReport } from '../server/src/lib/engineering-pack.ts';

test('the pack is 16 sources and none are installed', () => {
  assert.equal(ENGINEERING_PACK.length, 16);
  assert.equal(packReport().installed, 0);
  assert.ok(packReport().noLicense.includes('iwillig/clojure-skills'));
  assert.equal(ENGINEERING_PACK.every((row) => row.installed === false), true);
});

test('dispatch loads the matching specialist, not the whole pack', () => {
  const rust = dispatchSpecialists('fix the rust lease gate');
  assert.deepEqual(rust.specialists, ['rust']);
  assert.equal(rust.skills.length, 1);
  assert.equal(rust.skills[0].repo, 'rewrite-rs/skills');
  assert.ok(rust.loaded < 16);
});

test('a finished prompt is not a release', () => {
  assert.equal(acceptBuild({ acceptance: 'done', specialist: 'rust', realityNote: 'looks good' }).decision, 'NO-GO');
  assert.equal(acceptBuild({
    acceptance: 'lease rejects a missing id',
    specialist: 'rust',
    testExit: 0,
    reviewSid: 'rust',
    realityNote: 'cargo test passed',
  }).decision, 'NO-GO');
  assert.equal(acceptBuild({
    acceptance: 'lease rejects a missing id',
    specialist: 'rust',
    testExit: 0,
    reviewSid: 'review',
    realityNote: 'cargo test passed',
  }).decision, 'GO');
});
