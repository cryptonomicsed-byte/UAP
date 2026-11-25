import test from 'node:test';
import assert from 'node:assert/strict';
import { domainSurface } from '../server/src/lib/domain-surface.ts';

test('domain surface has no signer and does not approve commerce by default', () => {
  const surface = domainSurface();
  assert.equal(surface.chain.every((row) => row.signer === false), true);
  assert.equal(surface.chain.some((row) => row.family === 'sui_move'), true);
  assert.equal(surface.media.every((row) => row.canApproveCommercial === false || row.id === 'rights-reviewer'), true);
  assert.equal(JSON.stringify(surface).includes('privateKey'), false);
  assert.equal(surface.npc.npc_decorative, false);
});
