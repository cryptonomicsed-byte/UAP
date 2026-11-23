// B-20 source registry at the PostgreSQL boundary. The pipeline is tested without
// a database in tests/source-registry.test.mjs; this suite proves the migration
// enforces its own invariants: promotion needs a reviewer signature, ingestion
// runs are append-only, the application login can read the catalog but not write
// it, and a re-ingest refreshes observations without moving trust backwards.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { migratePostgres, grantApplicationRole } from '../../server/src/storage/postgres/migrations.ts';
import { ingestCandidates } from '../../server/src/sources/ingest.ts';
import { recordIngestion, toRegistryRow, ingestRunId } from '../../server/src/storage/postgres/source-registry.ts';

if (process.env.UAP_POSTGRES_TEST_DATABASE !== '1' || !process.env.TEST_DATABASE_URL ||
    !process.env.TEST_APP_DATABASE_URL) {
  throw new Error('Run PostgreSQL source registry tests through the disposable database harness.');
}

const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
const application = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL, max: 2 });
const appRole = (await application.query('SELECT current_user AS name')).rows[0].name;
const hex40 = 'd'.repeat(40);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const candidate = {
  group: 'Identity & general workforce',
  repository: 'Acme/Skills',
  url: 'https://github.com/Acme/Skills',
  proposedUse: 'role templates',
  status: 'USER_SUPPLIED / REQUIRES SOURCE+LICENSE AUDIT',
};
const fetcher = {
  probe: async () => ({ status: 200, archived: false, defaultBranch: 'main' }),
  resolveCommit: async () => hex40,
  listFiles: async () => [
    { path: 'SKILL.md', sha256: sha256('# Role'), size: 6 },
    { path: 'README.md', sha256: sha256('readme'), size: 6 },
  ],
  readLicenseFile: async () => 'MIT License\n\nPermission is hereby granted, free of charge...',
};
const report = async (now = 1000) => ingestCandidates([candidate], { fetcher, now: () => now });

beforeEach(async () => {
  await admin.query('DROP SCHEMA IF EXISTS uap CASCADE');
  await migratePostgres(admin);
  await grantApplicationRole(admin, appRole);
});
after(async () => { await application.end(); await admin.end(); });

test('the catalog is readable by the application login but only the operator can write it', async () => {
  const ingestion = await report();
  await recordIngestion(admin, ingestion, { runId: ingestRunId(ingestion), now: 2000 });
  const rows = await application.query('SELECT source_id, canonical_slug, trust_status FROM uap.source_repositories');
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].canonical_slug, 'acme/skills');
  assert.equal(rows.rows[0].trust_status, 'USER_SUPPLIED_UNVERIFIED');
  const row = toRegistryRow(ingestion.records[0], 2000);
  const columns = Object.keys(row);
  const jsonColumns = new Set(['kind_evidence', 'notices', 'license_obligations', 'reviewer_signature']);
  const values = columns.map((column) => (jsonColumns.has(column) && row[column] !== null && typeof row[column] === 'object' ? JSON.stringify(row[column]) : row[column]));
  await assert.rejects(
    application.query(`INSERT INTO uap.source_repositories(${columns.join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, values),
    { code: '42501' },
  );
  await assert.rejects(application.query("UPDATE uap.source_repositories SET access_detail='rewritten'"), { code: '42501' });
  await assert.rejects(application.query("INSERT INTO uap.source_ingest_runs(run_id,started_at,finished_at,candidate_count,recorded_count,unavailable_count,duplicate_count,report,created_at) VALUES ('ing_" + 'a'.repeat(32) + "',1,1,0,0,0,0,'{}',1)"), { code: '42501' });
});

test('a promoted row cannot exist without a reviewer signature', async () => {
  const ingestion = await report();
  await recordIngestion(admin, ingestion, { runId: ingestRunId(ingestion), now: 2000 });
  await assert.rejects(
    admin.query("UPDATE uap.source_repositories SET trust_status='LICENSE_APPROVED'"),
    { code: '23514' },
  );
  await admin.query(`UPDATE uap.source_repositories SET trust_status='LICENSE_APPROVED', reviewer_signature='{"reviewerId":"r1","signature":"sig","signedAt":1}'::jsonb`);
  assert.equal((await admin.query('SELECT trust_status FROM uap.source_repositories')).rows[0].trust_status, 'LICENSE_APPROVED');
});

test('re-ingestion refreshes observations but never moves trust or clears the reviewer signature', async () => {
  const first = await report(1000);
  await recordIngestion(admin, first, { runId: ingestRunId(first), now: 2000 });
  await admin.query(`UPDATE uap.source_repositories SET trust_status='STATIC_AUDITED', reviewer_signature='{"reviewerId":"r1","signature":"sig","signedAt":1}'::jsonb, last_audited_at=2500`);
  const second = await report(4000);
  await recordIngestion(admin, second, { runId: ingestRunId(second), now: 5000 });
  const row = (await admin.query('SELECT trust_status, reviewer_signature, last_seen_at, last_audited_at FROM uap.source_repositories')).rows[0];
  assert.equal(row.trust_status, 'STATIC_AUDITED');
  assert.equal(row.reviewer_signature.reviewerId, 'r1');
  assert.equal(Number(row.last_seen_at), 4000);
  assert.equal(Number(row.last_audited_at), 2500);
});

test('ingestion runs are append-only evidence', async () => {
  const ingestion = await report();
  const runId = ingestRunId(ingestion);
  await recordIngestion(admin, ingestion, { runId, now: 2000 });
  await assert.rejects(admin.query(`UPDATE uap.source_ingest_runs SET recorded_count=0 WHERE run_id=$1`, [runId]), { code: '42501' });
  await assert.rejects(admin.query('DELETE FROM uap.source_ingest_runs'), { code: '42501' });
  await assert.rejects(admin.query('TRUNCATE uap.source_ingest_runs'), { code: '42501' });
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM uap.source_ingest_runs')).rows[0].n, 1);
});
