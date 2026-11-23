#!/usr/bin/env node
// B-20 operator tool: import the candidate source CSV into the registry.
//
// Dry-run is the default and still performs real observations (access, pin,
// manifest, licence) so the printed report is evidence, not a guess. --apply
// additionally writes the catalog and its ingest run through the operator
// database connection; the application login can only read the catalog.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { parseCandidateCsv } from '../server/src/sources/candidates.ts';
import { ingestCandidates } from '../server/src/sources/ingest.ts';
import { createGitHubFetcher } from '../server/src/sources/github-fetcher.ts';
import { recordIngestion, ingestRunId } from '../server/src/storage/postgres/source-registry.ts';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: {
  csv: { type: 'string', default: path.join(root, 'docs/v6-blueprint/universal_agent_platform_v6_candidate_sources.csv') },
  apply: { type: 'boolean', default: false },
  limit: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} });

if (values.help) {
  process.stdout.write(`Usage: node --import tsx scripts/sources-ingest.mjs [--csv <path>] [--limit N] [--apply]\n\n` +
    `Observes every candidate: access status, pinned commit, SHA-256 manifest, licence and kind.\n` +
    `Without --apply nothing is written. With --apply, set UAP_POSTGRES_ADMIN_URL.\n`);
  process.exit(0);
}

const limit = values.limit === undefined ? Infinity : Number(values.limit);
if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.');

const csv = await readFile(values.csv, 'utf8');
const candidates = parseCandidateCsv(csv).slice(0, limit === Infinity ? undefined : limit);
const fetcher = createGitHubFetcher({ token: process.env.GITHUB_TOKEN ?? null });
const report = await ingestCandidates(candidates, { fetcher, now: () => Date.now() });

if (values.apply) {
  if (!process.env.UAP_POSTGRES_ADMIN_URL) throw new Error('Set UAP_POSTGRES_ADMIN_URL for --apply.');
  const pool = new Pool({ connectionString: process.env.UAP_POSTGRES_ADMIN_URL, max: 1, connectionTimeoutMillis: 5000 });
  try { await recordIngestion(pool, report, { runId: ingestRunId(report), now: Date.now() }); }
  finally { await pool.end(); }
}

process.stdout.write(`${JSON.stringify({
  applied: values.apply,
  counts: report.counts,
  unavailable: report.unavailable,
  duplicates: report.duplicates,
  records: report.records.map((record) => ({
    sourceId: record.sourceId,
    slug: record.canonicalSlug,
    access: record.access.status,
    kind: record.classification.kind,
    pinnedCommit: record.pinnedCommit,
    manifestDigest: record.manifest?.digest ?? null,
    license: record.license.spdx,
    availability: record.availability,
    unavailableReason: record.unavailableReason,
    trustStatus: record.trustStatus,
  })),
}, null, 2)}\n`);
