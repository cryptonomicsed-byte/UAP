// L-39 Audit gates + immutable deployment evidence chain (V6-12-08..10)
import { createHash } from 'node:crypto';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'open' | 'accepted_risk' | 'fixed' | 'false_positive';

export interface AuditFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  status: FindingStatus;
  category: 'access' | 'reentrancy' | 'ownership' | 'economic' | 'upgrade' | 'other';
}

export interface DeploymentArtifact {
  sourceHash: string; // sha256 of source tree or package
  artifactHash: string; // sha256 of built bytecode/package
  family: 'sui_move' | 'evm_solidity';
  network: string;
  deployedAt?: string;
  deployer?: string;
  txDigest?: string;
}

export interface EvidenceLink {
  prevHash: string | null;
  entryHash: string;
  artifact: DeploymentArtifact;
  findingsSnapshotHash: string;
  ownerSignoff: boolean;
  recordedAt: string;
}

export interface PromoteDecision {
  allowed: boolean;
  blockers: string[];
  evidenceHead: string | null;
}

const BLOCKING_SEVERITIES: FindingSeverity[] = ['critical', 'high'];

export function hashBytes(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function findingsSnapshotHash(findings: AuditFinding[]): string {
  const canonical = JSON.stringify(
    [...findings].sort((a, b) => a.id.localeCompare(b.id)).map((f) => ({
      id: f.id,
      severity: f.severity,
      status: f.status,
      category: f.category,
      title: f.title,
    })),
  );
  return hashBytes(canonical);
}

export function unresolvedBlockers(findings: AuditFinding[]): string[] {
  const blockers: string[] = [];
  for (const f of findings) {
    if (f.status === 'open' && BLOCKING_SEVERITIES.includes(f.severity)) {
      blockers.push(`unresolved_${f.severity}:${f.id}`);
    }
  }
  return blockers;
}

/**
 * V6-12-10: unresolved audit findings are blockers — never auto-promote on unit tests alone.
 * Unit-test-pass flag is explicitly ignored for promotion.
 */
export function evaluatePromotion(input: {
  findings: AuditFinding[];
  artifact: DeploymentArtifact;
  ownerSignoff: boolean;
  unitTestsPassed?: boolean; // ignored for allow decision
  chain: EvidenceLink[];
}): PromoteDecision {
  const blockers: string[] = [];
  blockers.push(...unresolvedBlockers(input.findings));

  if (!/^[a-f0-9]{64}$/.test(input.artifact.sourceHash)) blockers.push('invalid_source_hash');
  if (!/^[a-f0-9]{64}$/.test(input.artifact.artifactHash)) blockers.push('invalid_artifact_hash');

  if (input.artifact.network === 'mainnet' && !input.ownerSignoff) {
    blockers.push('mainnet_owner_signoff_required');
  }

  // Evidence chain integrity
  if (!verifyEvidenceChain(input.chain)) {
    blockers.push('evidence_chain_broken');
  }

  // unitTestsPassed intentionally not consulted
  void input.unitTestsPassed;

  const head = input.chain.length ? input.chain[input.chain.length - 1].entryHash : null;
  return {
    allowed: blockers.length === 0,
    blockers,
    evidenceHead: head,
  };
}

export function appendEvidence(
  chain: EvidenceLink[],
  artifact: DeploymentArtifact,
  findings: AuditFinding[],
  ownerSignoff: boolean,
  recordedAt = new Date().toISOString(),
): EvidenceLink[] {
  const prevHash = chain.length ? chain[chain.length - 1].entryHash : null;
  const findingsSnapshot = findingsSnapshotHash(findings);
  const entryHash = hashBytes(
    JSON.stringify({
      prevHash,
      sourceHash: artifact.sourceHash,
      artifactHash: artifact.artifactHash,
      family: artifact.family,
      network: artifact.network,
      findingsSnapshot,
      ownerSignoff,
      recordedAt,
      txDigest: artifact.txDigest ?? null,
      deployer: artifact.deployer ?? null,
    }),
  );
  return [
    ...chain,
    {
      prevHash,
      entryHash,
      artifact: { ...artifact },
      findingsSnapshotHash: findingsSnapshot,
      ownerSignoff,
      recordedAt,
    },
  ];
}

export function verifyEvidenceChain(chain: EvidenceLink[]): boolean {
  let expectedPrev: string | null = null;
  for (const link of chain) {
    if (link.prevHash !== expectedPrev) return false;
    const findingsSnapshot = link.findingsSnapshotHash;
    const recomputed = hashBytes(
      JSON.stringify({
        prevHash: link.prevHash,
        sourceHash: link.artifact.sourceHash,
        artifactHash: link.artifact.artifactHash,
        family: link.artifact.family,
        network: link.artifact.network,
        findingsSnapshot,
        ownerSignoff: link.ownerSignoff,
        recordedAt: link.recordedAt,
        txDigest: link.artifact.txDigest ?? null,
        deployer: link.artifact.deployer ?? null,
      }),
    );
    if (recomputed !== link.entryHash) return false;
    expectedPrev = link.entryHash;
  }
  return true;
}
