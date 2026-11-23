// B-22 (V6-02-08): separated source trust statuses + independent reviewer signature.
// Every promotion is a signed statement over source identity + pin + manifest + evidence
// digest. Trust is a ladder, each rung has its own evidence and its own reviewer
// capability, and the reviewer must be independent of submission, ingestion and audit.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

const {
  TRUST_LEVELS, promotionStatement, evidenceDigest, evaluatePromotion, assertPromotable,
  revokeSource, TrustError, requirementsFor, keyFingerprint,
} = await import('../server/src/sources/trust.ts');

const NOW = 1_760_000_000_000;

const source = (over = {}) => ({
  sourceId: 'src_' + 'a'.repeat(16),
  canonicalUrl: 'https://github.com/example/agent-skills',
  trustStatus: 'USER_SUPPLIED_UNVERIFIED',
  reviewerSignature: null,
  submittedBy: 'tenant-owner',
  ingestedBy: 'worker-c',
  access: { status: 'ok' },
  archived: false,
  pinnedCommit: 'b'.repeat(40),
  manifest: { digest: 'c'.repeat(64), fileCount: 84, totalBytes: 123456 },
  license: { spdx: 'MIT', commercialUse: 'allowed' },
  lastAuditedAt: null,
  revokedAt: null,
  ...over,
});

const evidence = (over = {}) => ({
  audit: { reportDigest: 'd'.repeat(64), auditorId: 'auditor-1', completedAt: NOW - 3_600_000, criticalFindings: 0, highFindings: 0 },
  sandbox: { runId: 'sbx_0001', outcome: 'pass', completedAt: NOW - 1_800_000 },
  tenantPolicy: { passed: true, policyDigest: 'e'.repeat(64) },
  ...over,
});

// A reviewer whose private key we hold, so the test can produce a real signature.
const withKey = ({ id = 'rev-alice', capabilities = ['source-reviewer'], active = true } = {}) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey,
    rev: { id, capabilities, active, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  };
};

const promote = ({ target = 'STATIC_AUDITED', src = source(), capabilities = ['source-reviewer', 'security-auditor'], id = 'rev-alice', active = true, ev = evidence(), now = NOW, signedAt = now - 1000, signFor = null, transform = (r) => r } = {}) => {
  const { rev, privateKey } = withKey({ id, capabilities, active });
  const fingerprint = keyFingerprint(rev.publicKeyPem);
  const statement = promotionStatement({
    source: signFor?.source ?? src,
    target: signFor?.target ?? target,
    reviewerId: rev.id,
    reviewerKey: signFor?.reviewerKey ?? fingerprint,
    signedAt,
    evidence: ev,
  });
  const signature = crypto.sign(null, Buffer.from(statement), privateKey).toString('base64');
  return transform({
    source: src, target, now, evidence: ev, reviewers: [rev],
    signature: { reviewerId: rev.id, keyFingerprint: signature && fingerprint, signedAt, signature },
  });
};

const codes = (result) => result.blockers.map((b) => b.code).sort();
const thrown = (fn) => {
  try { fn(); } catch (error) { return error; }
  return null;
};

// ---------- ladder shape ----------

test('trust statuses are an ordered ladder with distinct evidence per rung', () => {
  assert.deepEqual(TRUST_LEVELS, [
    'USER_SUPPLIED_UNVERIFIED', 'PUBLIC_LOCATED', 'PINNED_SHA',
    'LICENSE_APPROVED', 'STATIC_AUDITED', 'SANDBOX_EVALUATED', 'PUBLISHED',
  ]);
  const pinned = requirementsFor('PINNED_SHA');
  assert.equal(pinned.includes('pin'), true);
  assert.equal(pinned.includes('manifest'), true);
  assert.equal(pinned.includes('license'), false, 'a pin does not imply a licence review');
  assert.equal(requirementsFor('PUBLISHED').includes('sandbox'), true);
  assert.equal(requirementsFor('PUBLISHED').includes('tenant-policy'), true);
  assert.deepEqual(requirementsFor('USER_SUPPLIED_UNVERIFIED'), []);
});

test('the statement binds source, pin, manifest, target and evidence digest', () => {
  const src = source();
  const ev = evidence();
  const pem = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = keyFingerprint(pem);
  const stmt = promotionStatement({ source: src, target: 'STATIC_AUDITED', reviewerId: 'rev-alice', reviewerKey: fingerprint, signedAt: NOW, evidence: ev });
  const parsed = JSON.parse(stmt);
  assert.equal(parsed.kind, 'uap.source.trust.promotion');
  assert.equal(parsed.v, 1);
  assert.equal(parsed.source_id, src.sourceId);
  assert.equal(parsed.pinned_commit, src.pinnedCommit);
  assert.equal(parsed.manifest_digest, src.manifest.digest);
  assert.equal(parsed.to, 'STATIC_AUDITED');
  assert.equal(parsed.reviewer_key, fingerprint);
  assert.equal(parsed.evidence_digest, evidenceDigest(ev));
  // Byte-identical for the same input regardless of argument order.
  assert.equal(stmt, promotionStatement({ evidence: ev, signedAt: NOW, reviewerId: 'rev-alice', reviewerKey: fingerprint, target: 'STATIC_AUDITED', source: src }));
  // The evidence digest ignores object key order.
  const reordered = { tenantPolicy: { policyDigest: 'e'.repeat(64), passed: true }, sandbox: { ...ev.sandbox }, audit: { ...ev.audit } };
  assert.equal(evidenceDigest(reordered), evidenceDigest(ev));
});

// ---------- valid promotion ----------

test('a signed promotion with complete evidence is accepted and stamped', () => {
  const src = source();
  const result = evaluatePromotion(promote({ src }));
  assert.equal(result.allowed, true, JSON.stringify(result.blockers));
  assert.deepEqual(result.blockers, []);
  assert.equal(result.from, 'USER_SUPPLIED_UNVERIFIED');
  assert.equal(result.to, 'STATIC_AUDITED');
  assert.equal(result.record.trustStatus, 'STATIC_AUDITED');
  assert.equal(result.record.reviewerSignature.reviewerId, 'rev-alice');
  assert.equal(result.record.lastAuditedAt, NOW);
  assert.equal(result.record.sourceId, src.sourceId);
});

test('a full evidence bundle may skip rungs; partial evidence may not', () => {
  const full = evaluatePromotion(promote({ target: 'PUBLISHED', capabilities: ['source-reviewer', 'security-auditor', 'release-manager'] }));
  assert.equal(full.allowed, true, JSON.stringify(full.blockers));

  const licenceOnly = evaluatePromotion(promote({ target: 'PUBLISHED', capabilities: ['release-manager'], ev: { audit: evidence().audit } }));
  assert.equal(licenceOnly.allowed, false);
  assert.equal(codes(licenceOnly).includes('evidence_missing'), true);
  assert.equal(licenceOnly.blockers.some((b) => b.detail.includes('sandbox')), true);
});

// ---------- separation of statuses / direction ----------

test('same status is not a promotion and demotion needs revocation', () => {
  const same = evaluatePromotion(promote({ src: source({ trustStatus: 'STATIC_AUDITED' }) }));
  assert.equal(same.allowed, false);
  assert.deepEqual(codes(same), ['no_upward_move']);

  const down = evaluatePromotion(promote({ src: source({ trustStatus: 'STATIC_AUDITED' }), target: 'PINNED_SHA' }));
  assert.equal(down.allowed, false);
  assert.deepEqual(codes(down), ['demotion_requires_revocation']);

  const bogus = evaluatePromotion(promote({ target: 'TRUSTED' }));
  assert.equal(bogus.allowed, false);
  assert.deepEqual(codes(bogus), ['invalid_status']);
});

// ---------- signature ----------

test('promotion without a signature, unknown reviewer or wrong key is refused', () => {
  assert.deepEqual(codes(evaluatePromotion(promote({ transform: (r) => ({ ...r, signature: null }) }))), ['signature_required']);

  assert.deepEqual(codes(evaluatePromotion(promote({ transform: (r) => ({ ...r, reviewers: [] }) }))), ['unknown_reviewer']);

  const otherKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const swapped = promote({ transform: (r) => ({ ...r, reviewers: [{ ...r.reviewers[0], publicKeyPem: otherKey }] }) });
  assert.deepEqual(codes(evaluatePromotion(swapped)), ['reviewer_key_mismatch']);
});

test('a stale, future, replayed or retargeted signature is refused', () => {
  assert.deepEqual(codes(evaluatePromotion(promote({ signedAt: NOW - 16 * 60 * 1000 }))), ['signature_stale']);
  assert.deepEqual(codes(evaluatePromotion(promote({ signedAt: NOW + 5 * 60 * 1000 }))), ['signature_from_future']);

  // Signed for STATIC_AUDITED, presented for SANDBOX_EVALUATED.
  const retarget = promote({ target: 'SANDBOX_EVALUATED', signFor: { target: 'STATIC_AUDITED' } });
  assert.deepEqual(codes(evaluatePromotion(retarget)), ['signature_mismatch']);

  // Signed for one source, presented for another.
  const other = source({ sourceId: 'src_' + 'f'.repeat(16), canonicalUrl: 'https://github.com/other/repo' });
  const replay = promote({ src: other, signFor: { source: source() } });
  assert.deepEqual(codes(evaluatePromotion(replay)), ['signature_mismatch']);
});

// ---------- reviewer authority and independence ----------

test('inactive reviewers and reviewers without the rung capability cannot promote', () => {
  assert.deepEqual(codes(evaluatePromotion(promote({ active: false }))), ['reviewer_inactive']);

  // STATIC_AUDITED needs security-auditor, not just source-reviewer.
  assert.deepEqual(codes(evaluatePromotion(promote({ capabilities: ['source-reviewer'] }))), ['missing_capability']);
  // PUBLISHED needs release-manager.
  assert.deepEqual(codes(evaluatePromotion(promote({ target: 'PUBLISHED', capabilities: ['source-reviewer', 'security-auditor'] }))), ['missing_capability']);
});

test('the reviewer must be independent of submission, ingestion and the audit', () => {
  assert.deepEqual(codes(evaluatePromotion(promote({ src: source({ submittedBy: 'rev-alice' }) }))), ['reviewer_not_independent']);
  assert.deepEqual(codes(evaluatePromotion(promote({ src: source({ ingestedBy: 'rev-alice' }) }))), ['reviewer_not_independent']);

  const auditByReviewer = evidence({ audit: { ...evidence().audit, auditorId: 'rev-alice' } });
  assert.deepEqual(codes(evaluatePromotion(promote({ ev: auditByReviewer }))), ['reviewer_not_independent']);
});

// ---------- evidence gates ----------

test('missing or failing evidence blocks the target rung', () => {
  const noManifest = evaluatePromotion(promote({ src: source({ manifest: null }), target: 'PINNED_SHA' }));
  assert.equal(noManifest.allowed, false);
  assert.equal(codes(noManifest).includes('evidence_missing'), true);
  assert.equal(noManifest.blockers.some((b) => b.detail.includes('manifest')), true);

  const noPin = evaluatePromotion(promote({ src: source({ pinnedCommit: null }), target: 'PINNED_SHA' }));
  assert.equal(codes(noPin).includes('evidence_missing'), true);

  const unknownLicence = evaluatePromotion(promote({ src: source({ license: { spdx: null, commercialUse: 'unknown' } }), target: 'LICENSE_APPROVED' }));
  assert.equal(unknownLicence.blockers.some((b) => b.detail.includes('commercial')), true);

  const findings = evaluatePromotion(promote({ ev: evidence({ audit: { ...evidence().audit, criticalFindings: 2 } }) }));
  assert.deepEqual(codes(findings), ['audit_findings_block_promotion']);

  const sandboxFail = evaluatePromotion(promote({ target: 'SANDBOX_EVALUATED', ev: evidence({ sandbox: { ...evidence().sandbox, outcome: 'fail' } }) }));
  assert.deepEqual(codes(sandboxFail), ['sandbox_failed']);

  const policyFail = evaluatePromotion(promote({ target: 'PUBLISHED', capabilities: ['security-auditor', 'release-manager'], ev: evidence({ tenantPolicy: { passed: false, policyDigest: 'e'.repeat(64) } }) }));
  assert.deepEqual(codes(policyFail), ['tenant_policy_failed']);
});

test('an inaccessible source can never be promoted', () => {
  const result = evaluatePromotion(promote({ src: source({ access: { status: 'not-found' }, manifest: null, pinnedCommit: null }), target: 'PUBLIC_LOCATED' }));
  assert.equal(result.allowed, false);
  assert.equal(codes(result).includes('source_unavailable'), true);
  assert.equal(result.blockers[0].detail.includes('not-found'), true);
});

// ---------- revocation ----------

test('revocation clears the signature, demotes the source and blocks re-promotion until re-audit', () => {
  const promoted = source({
    trustStatus: 'PUBLISHED',
    reviewerSignature: { reviewerId: 'rev-bob', signature: 'zz', signedAt: NOW - 10_000 },
    lastAuditedAt: NOW - 10_000,
  });
  const revoked = revokeSource(promoted, { reason: 'compromised-origin', detail: 'Upstream account taken over.', advisoryId: 'GHSA-1', at: NOW, by: 'owner-1' });
  assert.equal(revoked.trustStatus, 'USER_SUPPLIED_UNVERIFIED');
  assert.equal(revoked.reviewerSignature, null);
  assert.equal(revoked.revokedAt, NOW);
  assert.equal(revoked.revocations.length, 1);
  assert.equal(revoked.revocations[0].reason, 'compromised-origin');

  const error = thrown(() => assertPromotable(promote({ src: revoked, target: 'PUBLIC_LOCATED', capabilities: ['source-reviewer'] })));
  assert.equal(error instanceof TrustError, true);
  assert.equal(error.code, 'trust_denied');
  assert.equal(error.blockers.map((b) => b.code).includes('revoked_requires_reaudit'), true);

  // A re-audit stamped after the revocation unlocks the ladder again.
  const reaudited = { ...revoked, lastAuditedAt: NOW + 1000 };
  const ok = evaluatePromotion(promote({ src: reaudited, target: 'PUBLIC_LOCATED', capabilities: ['source-reviewer'] }));
  assert.equal(ok.allowed, true, JSON.stringify(ok.blockers));
});
