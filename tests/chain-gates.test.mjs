import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  distinguishFamily,
  assertFamilyToolAllowed,
  evaluateTxApproval,
  fixtureForFamily,
  CHAIN_TEMPLATES,
  _resetApprovalIdempotencyForTests,
} from '../server/src/lib/chain-gates.ts';

test('L-38 Sui vs EVM templates differ in account model', () => {
  assert.equal(CHAIN_TEMPLATES.sui_move.accountModel, 'object_ownership');
  assert.equal(CHAIN_TEMPLATES.evm_solidity.accountModel, 'account_storage');
  assert.notDeepEqual(
    CHAIN_TEMPLATES.sui_move.analysisTools,
    CHAIN_TEMPLATES.evm_solidity.analysisTools,
  );
});

test('L-38 distinguishFamily by extension and manifest', () => {
  assert.equal(distinguishFamily({ fileExt: '.move' }), 'sui_move');
  assert.equal(distinguishFamily({ fileExt: '.sol' }), 'evm_solidity');
  assert.equal(distinguishFamily({ packageManifest: 'Move.toml' }), 'sui_move');
  assert.equal(distinguishFamily({ packageManifest: 'foundry.toml' }), 'evm_solidity');
  assert.equal(distinguishFamily({ mentions: ['hello'] }), null);
});

test('L-38 cross-family tools rejected', () => {
  assert.throws(
    () => assertFamilyToolAllowed('sui_move', 'forge test'),
    (e) => e.code === 'chain_family_tool_mismatch',
  );
  assert.throws(
    () => assertFamilyToolAllowed('evm_solidity', 'sui move test'),
    (e) => e.code === 'chain_family_tool_mismatch',
  );
  assert.doesNotThrow(() => assertFamilyToolAllowed('sui_move', 'sui client objects'));
});

test('L-38 localnet transfer with gas+recipient auto-allowed', () => {
  _resetApprovalIdempotencyForTests();
  const sui = fixtureForFamily('sui_move');
  const d = evaluateTxApproval({
    family: 'sui_move',
    network: 'localnet',
    action: 'transfer',
    maxGas: '1000000',
    recipient: sui.sampleRecipient,
    idempotencyKey: 't1',
    requestedBy: 'agent-1',
  });
  assert.equal(d.allowed, true);
  assert.equal(d.requiresHuman, false);
  assert.equal(d.blockers.length, 0);
});

test('L-38 mainnet deploy requires human + blocked auto', () => {
  _resetApprovalIdempotencyForTests();
  const d = evaluateTxApproval({
    family: 'evm_solidity',
    network: 'mainnet',
    action: 'deploy',
    maxGas: '5000000',
    idempotencyKey: 'main-1',
    requestedBy: 'agent-1',
  });
  assert.equal(d.allowed, false);
  assert.equal(d.requiresHuman, true);
  assert.ok(d.blockers.includes('mainnet_requires_owner_signoff'));
});

test('L-38 production signing key blocked', () => {
  _resetApprovalIdempotencyForTests();
  const d = evaluateTxApproval({
    family: 'evm_solidity',
    network: 'testnet',
    action: 'sign',
    signingKeyRef: 'vault://prod-hot-wallet',
    idempotencyKey: 'sign-1',
    requestedBy: 'model-tool',
  });
  assert.ok(d.blockers.includes('production_signing_key_blocked'));
  assert.equal(d.allowed, false);
});

test('L-38 idempotency replays same receipt', () => {
  _resetApprovalIdempotencyForTests();
  const req = {
    family: 'sui_move',
    network: 'testnet',
    action: 'call',
    maxGas: '10',
    recipient: fixtureForFamily('sui_move').sampleRecipient,
    idempotencyKey: 'idem-99',
    requestedBy: 'a',
  };
  const a = evaluateTxApproval(req);
  const b = evaluateTxApproval(req);
  assert.equal(a.receiptId, b.receiptId);
  assert.ok(b.blockers.includes('idempotent_replay'));
});

test('L-38 missing maxGas / bad recipient blocked', () => {
  _resetApprovalIdempotencyForTests();
  const d = evaluateTxApproval({
    family: 'evm_solidity',
    network: 'testnet',
    action: 'transfer',
    recipient: 'not-an-address',
    idempotencyKey: 'bad-1',
    requestedBy: 'a',
  });
  assert.ok(d.blockers.includes('max_gas_required'));
  assert.ok(d.blockers.includes('recipient_format_invalid'));
  assert.equal(d.allowed, false);
});
