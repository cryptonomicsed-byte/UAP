/**
 * B-20 / V6-02-01..06, V6-02-11: the ingestion pipeline.
 *
 * Every candidate ends in exactly one of two states: a recorded observation
 * (access, pin, manifest, kind, licence) or an explicit unavailable entry with a
 * reason. Nothing is dropped silently, nothing is retried into a different
 * answer, and nothing role-shaped is synthesized: an unaudited source has no
 * instructions, no tool grants and no install path. Promotion to an audited trust
 * status is B-22's reviewer workflow, not this module's.
 */
import crypto from 'node:crypto';
import { applySourceRedirect, normalizeSourceUrl, SourceUrlError, type NormalizedSource } from './normalize.js';
import { inspectSourceAccess, type AccessObservation, type RepositoryProbe, type SourceAccessClient } from './access.js';
import { pinSource, SourcePinError } from './pin.js';
import { buildSourceManifest, ManifestError, type ManifestFile, type SourceManifest } from './manifest.js';
import { inspectLicense, type LicenseInspection } from './license.js';
import { classifySource, type SourceClassification } from './classify.js';
import type { SourceCandidate } from './candidates.js';

export interface SourceFetcher extends SourceAccessClient {
  probe(owner: string, repo: string): Promise<RepositoryProbe>;
  resolveCommit(owner: string, repo: string, ref: string): Promise<string | null>;
  listFiles(owner: string, repo: string, commit: string): Promise<readonly ManifestFile[]>;
  readLicenseFile(owner: string, repo: string, commit: string): Promise<string | null>;
}

export interface SourceRecord {
  readonly sourceId: string;
  readonly group: string;
  readonly originalName: string;
  readonly originalUrl: string;
  readonly canonicalUrl: string;
  readonly canonicalSlug: string;
  readonly owner: string;
  readonly repo: string;
  readonly ownerDisplay: string;
  readonly repoDisplay: string;
  readonly proposedUse: string;
  readonly userSuppliedStatus: string;
  readonly access: AccessObservation;
  readonly archived: boolean;
  readonly pinnedCommit: string | null;
  readonly resolvedRef: string | null;
  readonly manifest: SourceManifest | null;
  readonly classification: SourceClassification;
  readonly license: LicenseInspection;
  readonly trustStatus: string;
  readonly reviewerSignature: ReviewerSignature | null;
  readonly availability: 'available' | 'unavailable';
  readonly unavailableReason: string | null;
  readonly observedAt: number;
}

export interface ReviewerSignature {
  readonly reviewerId: string;
  readonly signature: string;
  readonly signedAt: number;
}

export interface UnavailableCandidate {
  readonly url: string;
  readonly repository: string;
  readonly reason: string;
  readonly detail: string;
}

export interface DuplicateCandidate {
  readonly duplicate: string;
  readonly kept: string;
  readonly canonicalSlug: string;
}

export interface IngestionReport {
  readonly records: SourceRecord[];
  readonly unavailable: UnavailableCandidate[];
  readonly duplicates: DuplicateCandidate[];
  readonly counts: { candidates: number; recorded: number; unavailable: number; duplicates: number };
  readonly startedAt: number;
  readonly finishedAt: number;
}

export type SourceNotAuditableCode = 'source_not_auditable' | 'reviewer_signature_required';

export class SourceNotAuditableError extends Error {
  readonly code: SourceNotAuditableCode;
  readonly reason: string;
  constructor(reason: string) {
    const reviewer = reason === 'reviewer_signature_required';
    super(reviewer
      ? 'A promoted source requires an independent reviewer signature before it can be installed.'
      : 'This source has not been audited and cannot be installed or used as role instructions.');
    this.name = 'SourceNotAuditableError';
    this.reason = reason;
    this.code = reviewer ? 'reviewer_signature_required' : 'source_not_auditable';
  }
}

const UNREVIEWED_TRUST = 'USER_SUPPLIED_UNVERIFIED';
const AUDITED_TRUST = new Set(['LICENSE_APPROVED', 'STATIC_AUDITED', 'SANDBOX_EVALUATED', 'PUBLISHED']);

export function sourceIdFor(canonicalUrl: string): string {
  return `src_${crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16)}`;
}

function unavailableReasonFor(access: AccessObservation): string {
  switch (access.status) {
    case 'not-found': return 'not_found_or_private';
    case 'auth-required': return 'auth_required';
    case 'forbidden': return 'forbidden';
    case 'rate-limited': return 'rate_limited';
    case 'moved': return 'relocated';
    default: return 'network_error';
  }
}

function noticePaths(files: readonly ManifestFile[]): string[] {
  return files
    .filter((file) => /(^|\/)(NOTICE|NOTICE\.md|NOTICE\.txt|THIRD_PARTY_NOTICES|THIRD_PARTY_NOTICES\.md)$/i.test(file.path))
    .map((file) => file.path);
}

async function observeAvailable(source: NormalizedSource, fetcher: SourceFetcher): Promise<Omit<SourceRecord, 'sourceId' | 'group' | 'originalName' | 'originalUrl' | 'proposedUse' | 'userSuppliedStatus' | 'observedAt'>> {
  const access = await inspectSourceAccess(fetcher, source);
  const common = {
    canonicalUrl: source.canonicalUrl,
    canonicalSlug: source.canonicalSlug,
    owner: source.owner,
    repo: source.repo,
    ownerDisplay: source.ownerDisplay,
    repoDisplay: source.repoDisplay,
    access,
    archived: access.archived,
    trustStatus: UNREVIEWED_TRUST,
    reviewerSignature: null as ReviewerSignature | null,
  };
  if (access.status !== 'ok') {
    return {
      ...common,
      pinnedCommit: null,
      resolvedRef: null,
      manifest: null,
      classification: { kind: 'unknown', confidence: 'low', evidence: ['source not read'] },
      license: inspectLicense({ noticeTexts: [] }),
      availability: 'unavailable',
      unavailableReason: unavailableReasonFor(access),
    };
  }

  let pin;
  try {
    pin = await pinSource({ owner: source.owner, repo: source.repo, defaultBranch: access.defaultBranch ?? '', resolveCommit: (ref) => fetcher.resolveCommit(source.owner, source.repo, ref) });
  } catch (error) {
    const detail = error instanceof SourcePinError ? error.code : 'unpinned';
    return {
      ...common,
      pinnedCommit: null,
      resolvedRef: access.defaultBranch,
      manifest: null,
      classification: { kind: 'unknown', confidence: 'low', evidence: ['source not read'] },
      license: inspectLicense({ noticeTexts: [] }),
      availability: 'unavailable',
      unavailableReason: detail === 'unresolved_ref' ? 'unpinned_default_branch' : 'invalid_pin',
    };
  }

  let manifest: SourceManifest;
  try {
    manifest = buildSourceManifest(await fetcher.listFiles(source.owner, source.repo, pin.pinnedCommit));
  } catch (error) {
    return {
      ...common,
      pinnedCommit: pin.pinnedCommit,
      resolvedRef: pin.resolvedRef,
      manifest: null,
      classification: { kind: 'unknown', confidence: 'low', evidence: ['source tree unreadable'] },
      license: inspectLicense({ noticeTexts: [] }),
      availability: 'unavailable',
      unavailableReason: error instanceof ManifestError ? 'invalid_tree_listing' : 'source_tree_unreadable',
    };
  }
  if (manifest.fileCount === 0) {
    return {
      ...common,
      pinnedCommit: pin.pinnedCommit,
      resolvedRef: pin.resolvedRef,
      manifest: null,
      classification: { kind: 'unknown', confidence: 'low', evidence: ['empty source tree'] },
      license: inspectLicense({ noticeTexts: [] }),
      availability: 'unavailable',
      unavailableReason: 'no_files',
    };
  }

  const licenseText = await fetcher.readLicenseFile(source.owner, source.repo, pin.pinnedCommit).catch(() => null);
  const license = inspectLicense({
    licenseFile: licenseText ? 'LICENSE' : null,
    licenseText,
    noticeTexts: noticePaths(manifest.entries).map((noticePath) => ({ path: noticePath, text: '' })),
  });
  const classification = classifySource({ repository: `${source.ownerDisplay}/${source.repoDisplay}`, filePaths: manifest.entries.map((entry) => entry.path) });
  return {
    ...common,
    pinnedCommit: pin.pinnedCommit,
    resolvedRef: pin.resolvedRef,
    manifest,
    classification,
    license,
    availability: 'available',
    unavailableReason: null,
  };
}

export async function ingestCandidates(
  candidates: readonly SourceCandidate[],
  deps: { fetcher: SourceFetcher; now: () => number },
): Promise<IngestionReport> {
  const startedAt = deps.now();
  const records: SourceRecord[] = [];
  const unavailable: UnavailableCandidate[] = [];
  const duplicates: DuplicateCandidate[] = [];
  const seen = new Map<string, string>();

  for (const candidate of candidates) {
    let source: NormalizedSource;
    try {
      source = normalizeSourceUrl(candidate.url);
    } catch (error) {
      const detail = error instanceof SourceUrlError ? error.code : 'invalid_url';
      unavailable.push({ url: candidate.url, repository: candidate.repository, reason: 'unsupported_provider', detail });
      continue;
    }
    if (source.provider !== 'github') {
      unavailable.push({ url: candidate.url, repository: candidate.repository, reason: 'unsupported_provider', detail: 'non_github_host' });
      continue;
    }
    const keptUrl = seen.get(source.canonicalSlug);
    if (keptUrl) {
      duplicates.push({ duplicate: candidate.url, kept: keptUrl, canonicalSlug: source.canonicalSlug });
      continue;
    }
    seen.set(source.canonicalSlug, candidate.url);

    const observation = await observeAvailable(source, deps.fetcher);
    const record: SourceRecord = {
      sourceId: sourceIdFor(source.canonicalUrl),
      group: candidate.group,
      originalName: candidate.repository,
      originalUrl: candidate.url,
      proposedUse: candidate.proposedUse,
      userSuppliedStatus: candidate.status,
      observedAt: deps.now(),
      ...observation,
    };
    records.push(record);
    if (record.availability === 'unavailable') {
      unavailable.push({ url: candidate.url, repository: candidate.repository, reason: record.unavailableReason ?? 'unavailable', detail: record.access.detail });
    }
  }

  let finishedAt = deps.now();
  if (finishedAt < startedAt) finishedAt = startedAt;
  return {
    records,
    unavailable,
    duplicates,
    counts: { candidates: candidates.length, recorded: records.length, unavailable: unavailable.length, duplicates: duplicates.length },
    startedAt,
    finishedAt,
  };
}

/** Ordered blockers; the first one is what the UI and the prompt must say. */
export function auditBlockers(record: SourceRecord): string[] {
  const blockers: string[] = [];
  if (record.availability !== 'available') blockers.push('unavailable');
  if (record.archived) blockers.push('archived_source');
  if (!record.access || record.access.status !== 'ok') blockers.push('access_not_ok');
  if (!record.pinnedCommit) blockers.push('unpinned_source');
  if (!record.manifest || !/^[a-f0-9]{64}$/.test(record.manifest.digest)) blockers.push('missing_manifest');
  if (!record.license.spdx) blockers.push('license_not_declared');
  if (!AUDITED_TRUST.has(record.trustStatus)) blockers.push('trust_not_promoted');
  else if (!record.reviewerSignature) blockers.push('reviewer_signature_required');
  return blockers;
}

/** V6-02-11: callers that would install or prompt with a source must fail loudly. */
export function requireAuditableSource(record: SourceRecord): void {
  const [blocker] = auditBlockers(record);
  if (blocker) throw new SourceNotAuditableError(blocker);
}

export interface CatalogView {
  readonly sourceId: string;
  readonly title: string;
  readonly kind: SourceClassification['kind'];
  readonly trustStatus: string;
  readonly installable: boolean;
  readonly reason: string | null;
  readonly licenseSpdx: string | null;
  readonly riskClass: 'unclassified';
}

/** The only shape the catalog UI may render; no instructions or grants exist here. */
export function catalogView(record: SourceRecord): CatalogView {
  const [blocker] = auditBlockers(record);
  return {
    sourceId: record.sourceId,
    title: `${record.ownerDisplay}/${record.repoDisplay}`,
    kind: record.classification.kind,
    trustStatus: record.trustStatus,
    installable: !blocker,
    reason: blocker ?? null,
    licenseSpdx: record.license.spdx,
    riskClass: 'unclassified',
  };
}

export { applySourceRedirect };
