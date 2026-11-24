import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MEDIA_ROLES,
  createMediaAsset,
  reviewRights,
  assertProvenanceIntact,
  syncGameAudio,
  roleMay,
} from '../server/src/lib/media-rights.ts';

test('O-44 four media roles; only rights-reviewer clears commercial', () => {
  assert.equal(Object.keys(MEDIA_ROLES).length, 4);
  assert.equal(MEDIA_ROLES['rights-reviewer'].canApproveCommercial, true);
  assert.equal(MEDIA_ROLES['music-supervisor'].canApproveCommercial, false);
  assert.equal(roleMay('media-librarian', 'delete_provenance'), false);
});

test('O-44 music-supervisor cannot approve commercial asset', () => {
  const asset = createMediaAsset({
    title: 'Track',
    bytes: 'audio-bytes',
    license: 'CC-BY-4.0',
    licensor: 'Artist',
    commercialOk: true,
  });
  assert.throws(
    () => reviewRights(asset, 'music-supervisor', true),
    (e) => e.code === 'media_rights_role_denied',
  );
});

test('O-44 rights-reviewer clears licensed asset with provenance', () => {
  const asset = createMediaAsset({
    title: 'Track',
    bytes: 'audio-bytes-2',
    license: 'CC0',
    licensor: 'Public',
    commercialOk: true,
    stemHash: 'stem1',
  });
  const rev = reviewRights(asset, 'rights-reviewer', true, 'ok');
  assert.equal(rev.decision, 'cleared');
  assert.equal(asset.rightsStatus, 'cleared');
  assert.doesNotThrow(() => assertProvenanceIntact(asset));
});

test('O-44 unknown license cannot clear', () => {
  const asset = createMediaAsset({
    title: 'X',
    bytes: 'b',
    license: 'unknown',
    licensor: '?',
  });
  assert.throws(
    () => reviewRights(asset, 'rights-reviewer', true),
    (e) => e.code === 'media_license_unknown',
  );
});

test('O-45 game-audio sync requires cleared rights + matching stem', () => {
  const asset = createMediaAsset({
    title: 'OS',
    bytes: 'ost',
    license: 'MIT',
    licensor: 'Studio',
    stemHash: 'abc',
  });
  reviewRights(asset, 'rights-reviewer', true);
  const bad = syncGameAudio({ master: asset, stemHash: 'zzz', sceneId: 'lvl1', beatMarkerMs: 120 });
  assert.equal(bad.ok, false);
  assert.ok(bad.blockers.includes('stem_hash_mismatch'));

  const good = syncGameAudio({ master: asset, stemHash: 'abc', sceneId: 'lvl1', beatMarkerMs: 120 });
  assert.equal(good.ok, true);
  assert.equal(good.syncId.length, 24);
});

test('O-45 provenance tip must match content hash', () => {
  const asset = createMediaAsset({ title: 't', bytes: 'x', license: 'MIT', licensor: 'a' });
  asset.provenanceChain.push('deadbeef');
  assert.throws(() => assertProvenanceIntact(asset), (e) => e.code === 'media_provenance_mismatch');
});
