/**
 * B-20: persistence mapping for the source registry.
 *
 * `toRegistryRow` is the only place a pipeline record becomes a database row. It
 * whitelists columns (there is no path for an instruction, grant or role field
 * to reach the table), refuses a promoted trust status without a reviewer
 * signature and refuses malformed digests/slugs instead of coercing them.
 */
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { IngestionReport, SourceRecord } from '../../sources/ingest.js';

export type RegistryRowErrorCode = 'reviewer_signature_required' | 'invalid_manifest_digest' | 'invalid_canonical_slug' | 'invalid_source_id';

export class RegistryRowError extends Error {
  readonly code: RegistryRowErrorCode;
  constructor(code: RegistryRowErrorCode, message: string) {
    super(message);
    this.name = 'RegistryRowError';
    this.code = code;
  }
}

export type RegistryRow = Record<string, unknown>;

export function toRegistryRow(record: SourceRecord, now: number): RegistryRow {
  if (!/^src_[a-f0-9]{16}$/.test(record.sourceId)) throw new RegistryRowError('invalid_source_id', 'Source id is not a registry id.');
  if (!/^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/.test(record.canonicalSlug)) {
    throw new RegistryRowError('invalid_canonical_slug', 'Canonical slug must be lower-case owner/repo.');
  }
  if (record.manifest && !/^[a-f0-9]{64}$/.test(record.manifest.digest)) {
    throw new RegistryRowError('invalid_manifest_digest', 'Manifest digest is not a SHA-256.');
  }
  if (record.trustStatus !== 'USER_SUPPLIED_UNVERIFIED' && !record.reviewerSignature) {
    throw new RegistryRowError('reviewer_signature_required', 'A promoted source requires an independent reviewer signature.');
  }
  return {
    source_id: record.sourceId,
    provider: 'github',
    canonical_url: record.canonicalUrl,
    original_url: record.originalUrl,
    canonical_slug: record.canonicalSlug,
    owner: record.owner,
    repo_name: record.repo,
    owner_display: record.ownerDisplay,
    repo_display: record.repoDisplay,
    group_label: record.group,
    proposed_use: record.proposedUse,
    user_supplied_status: record.userSuppliedStatus,
    kind: record.classification.kind,
    kind_confidence: record.classification.confidence,
    kind_evidence: record.classification.evidence,
    access_status: record.access.status,
    access_detail: record.access.detail,
    http_status: record.access.httpStatus,
    archived: record.archived,
    redirect_url: record.access.redirectUrl,
    default_branch: record.access.defaultBranch,
    pinned_commit: record.pinnedCommit,
    pin_kind: record.pinnedCommit ? 'commit' : null,
    manifest_digest: record.manifest?.digest ?? null,
    manifest_file_count: record.manifest?.fileCount ?? null,
    manifest_total_bytes: record.manifest?.totalBytes ?? null,
    license_spdx: record.license.spdx,
    license_source: record.license.licenseSource,
    notices: record.license.notices,
    commercial_use: record.license.commercialUse,
    license_obligations: record.license.obligations,
    license_approval: record.license.approval,
    risk_class: 'unclassified',
    domains: [],
    supported_tools: [],
    availability: record.availability,
    unavailable_reason: record.unavailableReason,
    trust_status: record.trustStatus,
    reviewer_signature: record.reviewerSignature,
    first_seen_at: record.observedAt,
    last_seen_at: record.observedAt,
    last_audited_at: null,
    created_at: now,
    updated_at: now,
  };
}

const COLUMNS = [
  'source_id', 'provider', 'canonical_url', 'original_url', 'canonical_slug', 'owner', 'repo_name',
  'owner_display', 'repo_display', 'group_label', 'proposed_use', 'user_supplied_status', 'kind',
  'kind_confidence', 'kind_evidence', 'access_status', 'access_detail', 'http_status', 'archived',
  'redirect_url', 'default_branch', 'pinned_commit', 'pin_kind', 'manifest_digest', 'manifest_file_count',
  'manifest_total_bytes', 'license_spdx', 'license_source', 'notices', 'commercial_use',
  'license_obligations', 'license_approval', 'risk_class', 'domains', 'supported_tools', 'availability',
  'unavailable_reason', 'trust_status', 'reviewer_signature', 'first_seen_at', 'last_seen_at',
  'last_audited_at', 'created_at', 'updated_at',
] as const;

/** Observations refresh; trust and reviewer proof are never overwritten by ingestion. */
const REFRESHED = new Set([
  'kind', 'kind_confidence', 'kind_evidence', 'access_status', 'access_detail', 'http_status', 'archived',
  'redirect_url', 'default_branch', 'pinned_commit', 'pin_kind', 'manifest_digest', 'manifest_file_count',
  'manifest_total_bytes', 'license_spdx', 'license_source', 'notices', 'commercial_use',
  'license_obligations', 'availability', 'unavailable_reason', 'last_seen_at', 'updated_at',
]);

export function ingestRunId(report: IngestionReport): string {
  const material = JSON.stringify({ startedAt: report.startedAt, candidates: report.counts.candidates, records: report.records.map((record) => [record.sourceId, record.observedAt]) });
  return `ing_${crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

const JSON_COLUMNS = new Set(['kind_evidence', 'notices', 'license_obligations', 'reviewer_signature']);

export async function recordIngestion(pool: Pool, report: IngestionReport, options: { runId: string; now: number }): Promise<{ inserted: number; runId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const record of report.records) {
      const row = toRegistryRow(record, options.now);
      const placeholders = COLUMNS.map((_, index) => `$${index + 1}`).join(',');
      const updates = COLUMNS.filter((column) => REFRESHED.has(column)).map((column) => `${column}=EXCLUDED.${column}`).join(',');
      const values = COLUMNS.map((column) => {
        const value = row[column];
        return JSON_COLUMNS.has(column) && value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
      });
      await client.query(
        `INSERT INTO uap.source_repositories (${COLUMNS.join(',')}) VALUES (${placeholders})
         ON CONFLICT (source_id) DO UPDATE SET ${updates}`,
        values,
      );
    }
    await client.query(
      `INSERT INTO uap.source_ingest_runs(run_id,started_at,finished_at,candidate_count,recorded_count,unavailable_count,duplicate_count,report,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [options.runId, report.startedAt, report.finishedAt, report.counts.candidates, report.counts.recorded, report.counts.unavailable, report.counts.duplicates, JSON.stringify(report), options.now],
    );
    await client.query('COMMIT');
    return { inserted: report.records.length, runId: options.runId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listCatalog(pool: Pool, limit = 200): Promise<RegistryRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RegistryRowError('invalid_source_id', 'Catalog limit must be between 1 and 1000.');
  const result = await pool.query(`SELECT * FROM uap.source_repositories ORDER BY canonical_slug LIMIT $1`, [limit]);
  return result.rows;
}
