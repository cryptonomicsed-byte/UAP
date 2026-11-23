/**
 * B-22 / V6-02-08: separated source trust statuses and independent reviewer promotion.
 *
 * Trust is a ladder, not a boolean. Each rung states exactly which evidence has been
 * seen, and each rung is signed by a reviewer with the capability that rung requires:
 *
 *   USER_SUPPLIED_UNVERIFIED -> PUBLIC_LOCATED -> PINNED_SHA -> LICENSE_APPROVED
 *   -> STATIC_AUDITED -> SANDBOX_EVALUATED -> PUBLISHED
 *
 * A promotion is only accepted when all of the following hold:
 *  - the move is upward (demotion happens through `revokeSource`, never a signature);
 *  - the signed statement covers this source, its pin, its manifest digest, the exact
 *    target rung and a digest of the audit evidence, so a signature cannot be replayed
 *    onto another source or another rung;
 *  - the reviewer is registered and active, holds the rung's capability, and is not the
 *    person who submitted the source, ingested it or performed the audit;
 *  - the signature is fresh (15 minutes by default) and verifies against the reviewer's
 *    registered Ed25519 key.
 *
 * The module has no storage dependency: it decides on a record and returns the promoted
 * record, so the registry writer (B-20) persists a decision that was already validated.
 */
import crypto from 'node:crypto';

export const TRUST_LEVELS = [
  'USER_SUPPLIED_UNVERIFIED',
  'PUBLIC_LOCATED',
  'PINNED_SHA',
  'LICENSE_APPROVED',
  'STATIC_AUDITED',
  'SANDBOX_EVALUATED',
  'PUBLISHED',
] as const;

export type TrustStatus = (typeof TRUST_LEVELS)[number];

export const isTrustStatus = (value: unknown): value is TrustStatus =>
  typeof value === 'string' && (TRUST_LEVELS as readonly string[]).includes(value);

const rank = (status: string): number => (TRUST_LEVELS as readonly string[]).indexOf(status);

export type TrustCapability = 'source-reviewer' | 'security-auditor' | 'release-manager';

export type RevocationReason =
  | 'compromised-origin'
  | 'vulnerable-package'
  | 'license-violation'
  | 'policy-violation'
  | 'manual';

export interface ReviewerSignature {
  readonly reviewerId: string;
  readonly keyFingerprint: string;
  readonly signedAt: number;
  readonly signature: string;
}

export interface AuditEvidence {
  readonly reportDigest: string;
  readonly auditorId: string;
  readonly completedAt: number;
  readonly criticalFindings: number;
  readonly highFindings?: number;
}

export interface SandboxEvidence {
  readonly runId: string;
  readonly outcome: 'pass' | 'fail';
  readonly completedAt: number;
}

export interface TenantPolicyEvidence {
  readonly passed: boolean;
  readonly policyDigest: string;
}

export interface TrustEvidence {
  readonly audit?: AuditEvidence;
  readonly sandbox?: SandboxEvidence;
  readonly tenantPolicy?: TenantPolicyEvidence;
}

export interface PromotionRecord {
  readonly from: TrustStatus;
  readonly to: TrustStatus;
  readonly reviewerId: string;
  readonly signedAt: number;
  readonly evidenceDigest: string;
  readonly at: number;
}

export interface RevocationRecord {
  readonly reason: RevocationReason;
  readonly detail: string;
  readonly advisoryId: string | null;
  readonly at: number;
  readonly by: string;
}

export interface QuarantineRecord {
  readonly advisoryId: string;
  readonly severity: string;
  readonly at: number;
}

/**
 * The fields a decision needs. It is a structural subset of B-20's `SourceRecord`, so the
 * registry can pass its record directly without this module importing the pipeline.
 */
export interface TrustSubject {
  readonly sourceId: string;
  readonly canonicalUrl?: string;
  readonly trustStatus: TrustStatus;
  readonly reviewerSignature?: ReviewerSignature | null;
  readonly submittedBy?: string | null;
  readonly ingestedBy?: string | null;
  readonly access: { readonly status: string };
  readonly archived?: boolean;
  readonly pinnedCommit?: string | null;
  readonly manifest?: { readonly digest: string; readonly fileCount?: number } | null;
  readonly license?: { readonly spdx?: string | null; readonly commercialUse?: string } | null;
  readonly lastAuditedAt?: number | null;
  readonly revokedAt?: number | null;
  readonly evidence?: TrustEvidence;
  readonly promotions?: readonly PromotionRecord[];
  readonly revocations?: readonly RevocationRecord[];
  readonly quarantinedBy?: readonly QuarantineRecord[];
}

export interface ReviewerKey {
  readonly id: string;
  readonly publicKeyPem: string;
  readonly capabilities: readonly TrustCapability[];
  readonly active: boolean;
}

export interface PromotionSignature {
  readonly reviewerId: string;
  readonly keyFingerprint: string;
  readonly signedAt: number;
  readonly signature: string;
}

export interface PromotionRequest {
  readonly source: TrustSubject;
  readonly target: TrustStatus;
  readonly now: number;
  readonly signature?: PromotionSignature | null;
  readonly reviewers: readonly ReviewerKey[];
  readonly evidence?: TrustEvidence;
  readonly maxSignatureAgeMs?: number;
}

export type TrustBlockCode =
  | 'source_unavailable'
  | 'invalid_status'
  | 'no_upward_move'
  | 'demotion_requires_revocation'
  | 'revoked_requires_reaudit'
  | 'signature_required'
  | 'unknown_reviewer'
  | 'reviewer_inactive'
  | 'reviewer_key_mismatch'
  | 'missing_capability'
  | 'reviewer_not_independent'
  | 'signature_stale'
  | 'signature_from_future'
  | 'signature_invalid'
  | 'signature_mismatch'
  | 'evidence_missing'
  | 'audit_findings_block_promotion'
  | 'sandbox_failed'
  | 'tenant_policy_failed';

export interface TrustBlocker {
  readonly code: TrustBlockCode;
  readonly detail: string;
}

export interface PromotionResult {
  readonly schema: 'uap.source-trust-decision/1';
  readonly allowed: boolean;
  readonly from: string;
  readonly to: string;
  readonly blockers: readonly TrustBlocker[];
  readonly statementDigest: string | null;
  readonly record: TrustSubject | null;
}

export class TrustError extends Error {
  readonly code = 'trust_denied' as const;
  readonly blockers: readonly TrustBlocker[];

  constructor(blockers: readonly TrustBlocker[]) {
    super(`Source promotion denied: ${blockers.map((b) => b.code).join(', ')}`);
    this.name = 'TrustError';
    this.blockers = blockers;
  }
}

const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

/** Stable fingerprint of an Ed25519/SPKI public key, carried in the signed statement. */
export function keyFingerprint(publicKeyPem: string): string {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return sha256(der.toString('base64')).slice(0, 32);
}

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = stable((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
};

/** Digest of the audit evidence, so the signature covers the evidence and not just the rung. */
export function evidenceDigest(evidence: TrustEvidence | undefined): string {
  return sha256(JSON.stringify(stable(evidence ?? {})));
}

/** The exact bytes a reviewer signs. Fixed key order: identical inputs, identical bytes. */
export function promotionStatement(input: {
  source: TrustSubject;
  target: string;
  reviewerId: string;
  reviewerKey: string;
  signedAt: number;
  evidence?: TrustEvidence;
}): string {
  return JSON.stringify({
    v: 1,
    kind: 'uap.source.trust.promotion',
    source_id: input.source.sourceId,
    canonical_url: input.source.canonicalUrl ?? '',
    pinned_commit: input.source.pinnedCommit ?? '',
    manifest_digest: input.source.manifest?.digest ?? '',
    from: input.source.trustStatus,
    to: input.target,
    reviewer_id: input.reviewerId,
    reviewer_key: input.reviewerKey,
    signed_at: input.signedAt,
    evidence_digest: evidenceDigest(input.evidence ?? input.source.evidence),
  });
}

const REQUIREMENTS: Record<TrustStatus, readonly string[]> = {
  USER_SUPPLIED_UNVERIFIED: [],
  PUBLIC_LOCATED: ['access'],
  PINNED_SHA: ['access', 'pin', 'manifest'],
  LICENSE_APPROVED: ['access', 'pin', 'manifest', 'license'],
  STATIC_AUDITED: ['access', 'pin', 'manifest', 'license', 'static-audit'],
  SANDBOX_EVALUATED: ['access', 'pin', 'manifest', 'license', 'static-audit', 'sandbox'],
  PUBLISHED: ['access', 'pin', 'manifest', 'license', 'static-audit', 'sandbox', 'tenant-policy'],
};

/** Cumulative evidence a rung requires; skipping rungs means supplying all of it. */
export function requirementsFor(status: TrustStatus): readonly string[] {
  return REQUIREMENTS[status] ?? [];
}

const RUNG_CAPABILITY: Record<Exclude<TrustStatus, 'USER_SUPPLIED_UNVERIFIED'>, TrustCapability> = {
  PUBLIC_LOCATED: 'source-reviewer',
  PINNED_SHA: 'source-reviewer',
  LICENSE_APPROVED: 'source-reviewer',
  STATIC_AUDITED: 'security-auditor',
  SANDBOX_EVALUATED: 'security-auditor',
  PUBLISHED: 'release-manager',
};

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}([a-f0-9]{24})?$/;

const evidenceBlockers = (source: TrustSubject, target: TrustStatus, evidence: TrustEvidence): TrustBlocker[] => {
  const blockers: TrustBlocker[] = [];
  for (const requirement of requirementsFor(target)) {
    switch (requirement) {
      case 'access':
        if (source.access.status !== 'ok') blockers.push({ code: 'evidence_missing', detail: `source access status is ${source.access.status}` });
        break;
      case 'pin':
        if (!source.pinnedCommit || !GIT_SHA.test(source.pinnedCommit)) {
          blockers.push({ code: 'evidence_missing', detail: 'pinned commit missing or not a git SHA' });
        }
        break;
      case 'manifest':
        if (!source.manifest || !SHA256.test(source.manifest.digest) || (source.manifest.fileCount ?? 0) <= 0) {
          blockers.push({ code: 'evidence_missing', detail: 'manifest digest missing: no SHA-256 file manifest was recorded' });
        }
        break;
      case 'license':
        if (!source.license || (!source.license.spdx && (source.license.commercialUse ?? 'unknown') === 'unknown')) {
          blockers.push({ code: 'evidence_missing', detail: 'licence review missing: commercial use is unknown and no SPDX id was found' });
        }
        break;
      case 'static-audit':
        if (!evidence.audit || !SHA256.test(evidence.audit.reportDigest)) {
          blockers.push({ code: 'evidence_missing', detail: 'static audit evidence missing: no audit report digest' });
        } else if (evidence.audit.criticalFindings > 0) {
          blockers.push({ code: 'audit_findings_block_promotion', detail: `static audit reports ${evidence.audit.criticalFindings} unresolved critical finding(s)` });
        }
        break;
      case 'sandbox':
        if (!evidence.sandbox || !evidence.sandbox.runId) {
          blockers.push({ code: 'evidence_missing', detail: 'sandbox evaluation evidence missing: no sandbox run id' });
        } else if (evidence.sandbox.outcome !== 'pass') {
          blockers.push({ code: 'sandbox_failed', detail: `sandbox run ${evidence.sandbox.runId} ended ${evidence.sandbox.outcome}` });
        }
        break;
      case 'tenant-policy':
        if (!evidence.tenantPolicy || !SHA256.test(evidence.tenantPolicy.policyDigest)) {
          blockers.push({ code: 'evidence_missing', detail: 'tenant policy evidence missing: no policy digest' });
        } else if (!evidence.tenantPolicy.passed) {
          blockers.push({ code: 'tenant_policy_failed', detail: 'tenant policy filter rejected this source for the requesting tenant' });
        }
        break;
      default:
        break;
    }
  }
  return blockers;
};

const reviewerBlockers = (
  request: PromotionRequest,
  target: TrustStatus,
  evidence: TrustEvidence,
): { blockers: TrustBlocker[]; statement: string | null; reviewer: ReviewerKey | null } => {
  const { source, signature, now } = request;
  const maxAge = request.maxSignatureAgeMs ?? 15 * 60 * 1000;
  if (!signature || !signature.reviewerId || !signature.signature) {
    return { blockers: [{ code: 'signature_required', detail: 'an independent reviewer signature is required to promote a source' }], statement: null, reviewer: null };
  }

  const reviewer = request.reviewers.find((candidate) => candidate.id === signature.reviewerId) ?? null;
  if (!reviewer) {
    return { blockers: [{ code: 'unknown_reviewer', detail: `reviewer ${signature.reviewerId} is not in the trusted reviewer registry` }], statement: null, reviewer: null };
  }

  const blockers: TrustBlocker[] = [];
  if (!reviewer.active) blockers.push({ code: 'reviewer_inactive', detail: `reviewer ${reviewer.id} is deactivated` });

  const capability = RUNG_CAPABILITY[target as keyof typeof RUNG_CAPABILITY];
  if (capability && !reviewer.capabilities.includes(capability)) {
    blockers.push({ code: 'missing_capability', detail: `${target} requires the ${capability} capability; reviewer has ${reviewer.capabilities.join(', ') || 'none'}` });
  }

  if (source.submittedBy && source.submittedBy === reviewer.id) {
    blockers.push({ code: 'reviewer_not_independent', detail: 'the reviewer supplied this source' });
  } else if (source.ingestedBy && source.ingestedBy === reviewer.id) {
    blockers.push({ code: 'reviewer_not_independent', detail: 'the reviewer ingested this source' });
  }
  if (evidence.audit && evidence.audit.auditorId === reviewer.id) {
    blockers.push({ code: 'reviewer_not_independent', detail: 'the reviewer performed the audit being approved' });
  }

  const expected = keyFingerprint(reviewer.publicKeyPem);
  if (signature.keyFingerprint !== expected) {
    blockers.push({ code: 'reviewer_key_mismatch', detail: `signature was made with key ${signature.keyFingerprint || '(none)'} but ${reviewer.id} is registered with ${expected}` });
    return { blockers, statement: null, reviewer };
  }

  if (signature.signedAt < now - maxAge) {
    blockers.push({ code: 'signature_stale', detail: `signature is ${Math.round((now - signature.signedAt) / 60000)} minutes old (limit ${Math.round(maxAge / 60000)})` });
  }
  if (signature.signedAt > now + 2 * 60 * 1000) {
    blockers.push({ code: 'signature_from_future', detail: `signature is stamped ${Math.round((signature.signedAt - now) / 60000)} minutes ahead` });
  }
  if (blockers.some((b) => b.code === 'signature_stale' || b.code === 'signature_from_future')) {
    return { blockers, statement: null, reviewer };
  }

  const statement = promotionStatement({ source, target, reviewerId: reviewer.id, reviewerKey: expected, signedAt: signature.signedAt, evidence });
  const raw = Buffer.from(signature.signature, 'base64');
  if (raw.length !== 64) {
    blockers.push({ code: 'signature_invalid', detail: 'signature is not a 64-byte Ed25519 signature' });
  } else if (!crypto.verify(null, Buffer.from(statement, 'utf8'), reviewer.publicKeyPem, raw)) {
    blockers.push({ code: 'signature_mismatch', detail: 'signature does not cover this source, pin, rung and evidence' });
  }
  return { blockers, statement, reviewer };
};

/**
 * Decide a promotion. Pure: no storage, no clock — `now` is supplied.
 */
export function evaluatePromotion(request: PromotionRequest): PromotionResult {
  const { source, target, now } = request;
  const evidence = request.evidence ?? source.evidence ?? {};
  const from = source.trustStatus;
  const result = (blockers: readonly TrustBlocker[], statementDigest: string | null = null, record: TrustSubject | null = null): PromotionResult => ({
    schema: 'uap.source-trust-decision/1',
    allowed: blockers.length === 0,
    from,
    to: target,
    blockers,
    statementDigest,
    record: blockers.length === 0 ? record : null,
  });

  if (source.access.status !== 'ok') {
    return result([{ code: 'source_unavailable', detail: `source access status is ${source.access.status}; an unavailable source cannot be promoted` }]);
  }
  if (!isTrustStatus(target) || !isTrustStatus(from)) {
    return result([{ code: 'invalid_status', detail: `unknown trust status (from ${from}, to ${target})` }]);
  }
  if (target === from) return result([{ code: 'no_upward_move', detail: `source is already ${target}` }]);
  if (rank(target) < rank(from)) {
    return result([{ code: 'demotion_requires_revocation', detail: `moving down from ${from} to ${target} requires a revocation, not a promotion` }]);
  }
  if (source.revokedAt != null && (source.lastAuditedAt == null || source.lastAuditedAt <= source.revokedAt)) {
    return result([{ code: 'revoked_requires_reaudit', detail: `source was revoked at ${source.revokedAt}; a fresh re-audit must be stamped after that time` }]);
  }

  const blockers = evidenceBlockers(source, target, evidence);
  const reviewer = reviewerBlockers(request, target, evidence);
  blockers.push(...reviewer.blockers);
  if (blockers.length > 0) return result(blockers);

  const statementDigest = sha256(reviewer.statement ?? '');
  const record: TrustSubject = {
    ...source,
    trustStatus: target,
    reviewerSignature: {
      reviewerId: reviewer.reviewer!.id,
      keyFingerprint: keyFingerprint(reviewer.reviewer!.publicKeyPem),
      signedAt: request.signature!.signedAt,
      signature: request.signature!.signature,
    },
    lastAuditedAt: Math.max(source.lastAuditedAt ?? 0, now),
    evidence,
    promotions: [
      ...(source.promotions ?? []),
      { from, to: target, reviewerId: reviewer.reviewer!.id, signedAt: request.signature!.signedAt, evidenceDigest: evidenceDigest(evidence), at: now },
    ],
  };
  return result([], statementDigest, record);
}

/** Same decision, but throws `TrustError` so a caller cannot ignore a denial. */
export function assertPromotable(request: PromotionRequest): TrustSubject {
  const decision = evaluatePromotion(request);
  if (!decision.allowed || !decision.record) throw new TrustError(decision.blockers);
  return decision.record;
}

/**
 * Revocation is not a signature: it is an operator or advisory action that clears the
 * reviewer signature and demotes the source to unverified, so the catalogue can never keep
 * showing an "audited" badge for a compromised origin. It only needs the trust fields, so a
 * re-audit record can be revoked without pretending to carry a full registry row.
 */
export interface RevocableSubject {
  readonly trustStatus: TrustStatus;
  readonly reviewerSignature?: ReviewerSignature | null;
  readonly revokedAt?: number | null;
  readonly revocations?: readonly RevocationRecord[];
}

export function revokeSource<T extends RevocableSubject>(
  source: T,
  input: { reason: RevocationReason; detail: string; advisoryId?: string | null; at: number; by: string },
): T {
  const reasons: readonly RevocationReason[] = ['compromised-origin', 'vulnerable-package', 'license-violation', 'policy-violation', 'manual'];
  if (!reasons.includes(input.reason)) throw new Error(`Unknown revocation reason: ${input.reason}`);
  if (!input.detail.trim()) throw new Error('A revocation needs a detail string for the audit trail.');
  if (!input.by.trim()) throw new Error('A revocation needs the acting identity.');
  return {
    ...source,
    trustStatus: 'USER_SUPPLIED_UNVERIFIED',
    reviewerSignature: null,
    revokedAt: input.at,
    revocations: [
      ...(source.revocations ?? []),
      { reason: input.reason, detail: input.detail, advisoryId: input.advisoryId ?? null, at: input.at, by: input.by },
    ],
  };
}
