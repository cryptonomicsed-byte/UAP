// L-38 Blockchain domain: Sui Move vs EVM separation + approval gates (V6-12-01..07 partial)
import { createHash } from 'node:crypto';

export type ChainFamily = 'sui_move' | 'evm_solidity';
export type NetworkTier = 'localnet' | 'testnet' | 'mainnet' | 'devnet';

export interface ChainTemplate {
  family: ChainFamily;
  /** Object model vs account/storage model */
  accountModel: 'object_ownership' | 'account_storage';
  defaultNetworks: NetworkTier[];
  analysisTools: string[];
  forbiddenOnFamily: string[];
}

export const CHAIN_TEMPLATES: Record<ChainFamily, ChainTemplate> = {
  sui_move: {
    family: 'sui_move',
    accountModel: 'object_ownership',
    defaultNetworks: ['localnet', 'testnet', 'devnet', 'mainnet'],
    analysisTools: ['sui move test', 'sui move build', 'sui client objects'],
    forbiddenOnFamily: ['foundry', 'forge', 'cast', 'solc', 'hardhat', 'msg.sender', 'delegatecall'],
  },
  evm_solidity: {
    family: 'evm_solidity',
    accountModel: 'account_storage',
    defaultNetworks: ['localnet', 'testnet', 'mainnet'],
    analysisTools: ['forge test', 'forge build', 'slither', 'cast'],
    forbiddenOnFamily: ['sui move', 'object ownership', 'UID', 'sui::transfer'],
  },
};

export interface TxApprovalRequest {
  family: ChainFamily;
  network: NetworkTier;
  action: 'deploy' | 'transfer' | 'call' | 'upgrade' | 'sign';
  maxGas?: string;
  recipient?: string;
  value?: string;
  /** production signing material reference — must never be model-readable */
  signingKeyRef?: string;
  idempotencyKey: string;
  requestedBy: string;
}

export interface ApprovalDecision {
  allowed: boolean;
  requiresHuman: boolean;
  blockers: string[];
  receiptId: string;
  family: ChainFamily;
  network: NetworkTier;
}

const SEEN_IDEMPOTENCY = new Map<string, ApprovalDecision>();

export function distinguishFamily(input: {
  mentions?: string[];
  fileExt?: string;
  packageManifest?: string;
}): ChainFamily | null {
  const text = [
    ...(input.mentions ?? []),
    input.fileExt ?? '',
    input.packageManifest ?? '',
  ].join(' ').toLowerCase();

  const suiScore =
    (/\bsui\b/.test(text) ? 2 : 0) +
    (/\bmove\b/.test(text) ? 1 : 0) +
    (text.includes('move.toml') ? 3 : 0) +
    (text.endsWith('.move') || input.fileExt === '.move' ? 3 : 0);

  const evmScore =
    (/\bsolidity\b|\bevm\b|\bethereum\b/.test(text) ? 2 : 0) +
    (text.includes('foundry.toml') || text.includes('hardhat.config') ? 3 : 0) +
    (input.fileExt === '.sol' || text.endsWith('.sol') ? 3 : 0);

  if (suiScore === 0 && evmScore === 0) return null;
  if (suiScore === evmScore) return null; // ambiguous — force explicit
  return suiScore > evmScore ? 'sui_move' : 'evm_solidity';
}

export function assertFamilyToolAllowed(family: ChainFamily, toolName: string): void {
  const t = CHAIN_TEMPLATES[family];
  const lower = toolName.toLowerCase();
  for (const bad of t.forbiddenOnFamily) {
    if (lower.includes(bad.toLowerCase())) {
      throw Object.assign(new Error(`tool ${toolName} forbidden on ${family}`), {
        code: 'chain_family_tool_mismatch',
        family,
        toolName,
      });
    }
  }
}

/**
 * Approval gates: max-gas, recipient, network, mainnet human, no model access to prod keys.
 * Idempotent on idempotencyKey.
 */
export function evaluateTxApproval(req: TxApprovalRequest): ApprovalDecision {
  const cached = SEEN_IDEMPOTENCY.get(req.idempotencyKey);
  if (cached) return { ...cached, blockers: [...cached.blockers, 'idempotent_replay'] };

  const blockers: string[] = [];
  let requiresHuman = false;

  if (!CHAIN_TEMPLATES[req.family]) blockers.push('unknown_family');
  if (!['localnet', 'testnet', 'mainnet', 'devnet'].includes(req.network)) {
    blockers.push('unknown_network');
  }

  // V6-12-06: block model tool access to production signing keys
  if (req.signingKeyRef) {
    const ref = req.signingKeyRef.toLowerCase();
    if (ref.includes('prod') || ref.includes('mainnet') || ref.includes('hot-wallet')) {
      blockers.push('production_signing_key_blocked');
      requiresHuman = true;
    }
  }

  // V6-12-07: max-gas / transfer / recipient / network gates
  if (req.action === 'transfer' || req.action === 'call') {
    if (!req.recipient) blockers.push('recipient_required');
    if (req.recipient && !isPlausibleRecipient(req.family, req.recipient)) {
      blockers.push('recipient_format_invalid');
    }
  }
  if ((req.action === 'deploy' || req.action === 'call' || req.action === 'transfer') && !req.maxGas) {
    blockers.push('max_gas_required');
  }
  if (req.network === 'mainnet') {
    requiresHuman = true;
    if (req.action === 'deploy' || req.action === 'upgrade' || req.action === 'sign') {
      blockers.push('mainnet_requires_owner_signoff');
    }
  }
  if (req.action === 'upgrade') {
    requiresHuman = true;
    blockers.push('upgrade_requires_independent_review');
  }

  // value-at-risk heuristic
  if (req.value && isHighValue(req.value)) {
    requiresHuman = true;
    blockers.push('value_at_risk_threshold');
  }

  // Auto-allow only when zero blockers and no human gate (local/test safe paths).
  const autoAllowed = blockers.length === 0 && !requiresHuman && req.network !== 'mainnet';

  const decision: ApprovalDecision = {
    allowed: autoAllowed,
    requiresHuman: requiresHuman || req.network === 'mainnet',
    blockers,
    receiptId: receiptIdFor(req),
    family: req.family,
    network: req.network,
  };
  SEEN_IDEMPOTENCY.set(req.idempotencyKey, decision);
  return decision;
}

function isPlausibleRecipient(family: ChainFamily, recipient: string): boolean {
  if (family === 'sui_move') {
    // Sui addresses 0x + 64 hex (loose) or shorter object ids
    return /^0x[0-9a-fA-F]{1,64}$/.test(recipient);
  }
  // EVM
  return /^0x[0-9a-fA-F]{40}$/.test(recipient);
}

function isHighValue(value: string): boolean {
  const n = Number(value);
  if (!Number.isFinite(n)) return true;
  return n >= 1_000; // unitless threshold for tests; real config later
}

function receiptIdFor(req: TxApprovalRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({
      f: req.family,
      n: req.network,
      a: req.action,
      i: req.idempotencyKey,
      r: req.recipient ?? '',
      g: req.maxGas ?? '',
      v: req.value ?? '',
      by: req.requestedBy,
    }))
    .digest('hex')
    .slice(0, 32);
}

/** Clear idempotency cache (tests only). */
export function _resetApprovalIdempotencyForTests(): void {
  SEEN_IDEMPOTENCY.clear();
}

export function fixtureForFamily(family: ChainFamily): {
  sampleRecipient: string;
  sampleManifest: string;
  sampleExt: string;
} {
  if (family === 'sui_move') {
    return {
      sampleRecipient: '0x' + 'ab'.repeat(32),
      sampleManifest: 'Move.toml',
      sampleExt: '.move',
    };
  }
  return {
    sampleRecipient: '0x' + '11'.repeat(20),
    sampleManifest: 'foundry.toml',
    sampleExt: '.sol',
  };
}
