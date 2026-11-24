import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendEvidence,
  evaluatePromotion,
  findingsSnapshotHash,
  hashBytes,
  unresolvedBlockers,
  verifyEvidenceChain,
} from '../server/src/lib/deploy-evidence.ts';

const src = hashBytes('source-v1');
const art = hashBytes('bytecode-v1');

test('L-39 unresolved critical/high block promotion even if unit tests pass', () => {
  const findings = [
    { id: 'F1', severity: 'critical', title: 'reentrancy', status: 'open', category: 'reentrancy' },
    { id: 'F2', severity: 'low', title: 'nits', status: 'open', category: 'other' },
  ];
  assert.ok(unresolvedBlockers(findings).some((b) => b.includes('F1')));
  const d = evaluatePromotion({
    findings,
    artifact: { sourceHash: src, artifactHash: art, family: 'evm_solidity', network: 'testnet' },
    ownerSignoff: true,
    unitTestsPassed: true,
    chain: [],
  });
  assert.equal(d.allowed, false);
  assert.ok(d.blockers.some((b) => b.includes('F1')));
});

test('L-39 fixed findings allow promotion on testnet', () => {
  const findings = [
    { id: 'F1', severity: 'high', title: 'access', status: 'fixed', category: 'access' },
  ];
  const d = evaluatePromotion({
    findings,
    artifact: { sourceHash: src, artifactHash: art, family: 'sui_move', network: 'testnet' },
    ownerSignoff: false,
    unitTestsPassed: false, // still allow if audits clean
    chain: [],
  });
  assert.equal(d.allowed, true);
});

test('L-39 mainnet requires owner signoff', () => {
  const d = evaluatePromotion({
    findings: [],
    artifact: { sourceHash: src, artifactHash: art, family: 'evm_solidity', network: 'mainnet' },
    ownerSignoff: false,
    chain: [],
  });
  assert.equal(d.allowed, false);
  assert.ok(d.blockers.includes('mainnet_owner_signoff_required'));
});

test('L-39 evidence chain links and verifies', () => {
  let chain = [];
  chain = appendEvidence(
    chain,
    { sourceHash: src, artifactHash: art, family: 'sui_move', network: 'localnet', deployer: 'alice' },
    [],
    false,
    '2026-01-01T00:00:00.000Z',
  );
  const art2 = hashBytes('bytecode-v2');
  chain = appendEvidence(
    chain,
    { sourceHash: hashBytes('source-v2'), artifactHash: art2, family: 'sui_move', network: 'testnet', txDigest: '0xabc' },
    [{ id: 'F0', severity: 'info', title: 'note', status: 'open', category: 'other' }],
    true,
    '2026-01-02T00:00:00.000Z',
  );
  assert.equal(chain.length, 2);
  assert.equal(chain[1].prevHash, chain[0].entryHash);
  assert.equal(verifyEvidenceChain(chain), true);

  // tamper
  const broken = chain.map((c, i) => (i === 1 ? { ...c, entryHash: '0'.repeat(64) } : c));
  assert.equal(verifyEvidenceChain(broken), false);

  const d = evaluatePromotion({
    findings: [],
    artifact: { sourceHash: hashBytes('source-v2'), artifactHash: art2, family: 'sui_move', network: 'testnet' },
    ownerSignoff: true,
    chain: broken,
  });
  assert.ok(d.blockers.includes('evidence_chain_broken'));
});

test('L-39 findings snapshot is order-independent', () => {
  const a = [
    { id: 'b', severity: 'low', title: 'b', status: 'open', category: 'other' },
    { id: 'a', severity: 'low', title: 'a', status: 'open', category: 'other' },
  ];
  const b = [...a].reverse();
  assert.equal(findingsSnapshotHash(a), findingsSnapshotHash(b));
});

test('L-39 invalid hashes rejected', () => {
  const d = evaluatePromotion({
    findings: [],
    artifact: { sourceHash: 'nope', artifactHash: art, family: 'evm_solidity', network: 'testnet' },
    ownerSignoff: true,
    chain: [],
  });
  assert.ok(d.blockers.includes('invalid_source_hash'));
});
