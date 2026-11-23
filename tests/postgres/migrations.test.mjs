// Destructive operations are confined to the disposable per-file test database
// created by scripts/test-postgres.mjs. This suite never accepts a production URL.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import pg from 'pg';
import { migratePostgres, migrationStatus, grantApplicationRole, PostgresMigrationError } from '../../server/src/storage/postgres/migrations.ts';
import { POSTGRES_MIGRATIONS } from '../../server/src/storage/postgres/schema.ts';

if (process.env.UAP_POSTGRES_TEST_DATABASE !== '1') throw new Error('Run PostgreSQL tests through the disposable database harness.');
if (!process.env.TEST_DATABASE_URL || !process.env.TEST_APP_DATABASE_URL) throw new Error('PostgreSQL test database URLs are required.');
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
const application = new pg.Pool({ connectionString: process.env.TEST_APP_DATABASE_URL, max: 2 });
const appRole = (await application.query('SELECT current_user AS name')).rows[0].name;
const quotedAppRole = `"${appRole.replace(/"/g, '""')}"`;

beforeEach(async () => {
  await admin.query('DROP SCHEMA IF EXISTS uap CASCADE');
});
after(async () => { await application.end(); await admin.end(); });

const migrationIds = POSTGRES_MIGRATIONS.map(migration => migration.id);
const currentVersion = migrationIds.at(-1);
const coreTables = ['users', 'organizations', 'memberships', 'workspaces', 'agents', 'import_receipts', 'conversations', 'message_rows', 'llm_items', 'auth_sessions', 'history_import_receipts', 'tasks', 'task_jobs', 'agent_runs', 'approvals', 'job_events', 'source_repositories', 'source_ingest_runs'];

test('fresh migration creates a forced-RLS schema and repeat application preserves its ledger', async () => {
  assert.deepEqual(await migrationStatus(admin), []);
  assert.deepEqual(await migratePostgres(admin), { applied: migrationIds, currentVersion });
  const first = await migrationStatus(admin);
  assert.equal(first.length, migrationIds.length);
  assert.match(first[0].checksum, /^[a-f0-9]{64}$/);
  assert.equal(first[0].name, POSTGRES_MIGRATIONS[0].name);
  assert.deepEqual(await migratePostgres(admin), { applied: [], currentVersion });
  assert.deepEqual(await migrationStatus(admin), first);
  const tables = await admin.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='uap' AND relname = ANY($1::text[]) ORDER BY relname`, [coreTables]);
  assert.deepEqual(tables.rows.map(row => row.relname), [...coreTables].sort());
  assert.equal(tables.rows.every(row => row.relrowsecurity && row.relforcerowsecurity), true);
});

test('changed checksums and unknown or missing migration history stop without modifying tables', async () => {
  await migratePostgres(admin);
  await admin.query("INSERT INTO uap.users VALUES ('stable-user','stable@example.test','Stable',1)");
  const original = (await migrationStatus(admin))[0];
  await admin.query('UPDATE uap.schema_migrations SET checksum=$1 WHERE id=1', ['0'.repeat(64)]);
  await assert.rejects(migratePostgres(admin), PostgresMigrationError);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM uap.users WHERE id='stable-user'")).rows[0].n, 1);
  await admin.query('UPDATE uap.schema_migrations SET checksum=$1 WHERE id=1', [original.checksum]);
  await admin.query('UPDATE uap.schema_migrations SET id=$1 WHERE id=1', [currentVersion + 10]);
  await assert.rejects(migratePostgres(admin), /history is missing, unknown/);
  await admin.query('DELETE FROM uap.schema_migrations');
  await assert.rejects(migratePostgres(admin), /unversioned uap schema/);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM uap.users')).rows[0].n, 1);
});

test('a failed pending batch rolls back schema, earlier migrations and ledger together', async () => {
  const transactionEscape = { id: currentVersion + 1, name: 'escape_fixture', sql: 'COMMIT; CREATE TABLE uap.partial_fixture(id text);' };
  await assert.rejects(migratePostgres(admin, [...POSTGRES_MIGRATIONS, transactionEscape]), /cannot control transactions/);
  assert.equal((await admin.query("SELECT to_regnamespace('uap') IS NULL AS absent")).rows[0].absent, true);
  const broken = { id: currentVersion + 1, name: 'intentional_failure_fixture', sql: 'CREATE TABLE uap.partial_fixture(id text); SELECT missing_fixture_function();' };
  await assert.rejects(migratePostgres(admin, [...POSTGRES_MIGRATIONS, broken]), /missing_fixture_function/);
  assert.equal((await admin.query("SELECT to_regnamespace('uap') IS NULL AS absent")).rows[0].absent, true);
  assert.deepEqual(await migratePostgres(admin), { applied: migrationIds, currentVersion });
  const before = await migrationStatus(admin);
  await assert.rejects(migratePostgres(admin, [...POSTGRES_MIGRATIONS, broken]), /missing_fixture_function/);
  assert.deepEqual(await migrationStatus(admin), before);
  assert.equal((await admin.query("SELECT to_regclass('uap.partial_fixture') IS NULL AS absent")).rows[0].absent, true);
});

test('concurrent migration runners serialize and apply each migration exactly once', async () => {
  const runs = await Promise.all([migratePostgres(admin), migratePostgres(admin), migratePostgres(admin)]);
  assert.equal(runs.filter(run => run.applied.length === migrationIds.length).length, 1);
  assert.equal(runs.every(run => run.currentVersion === currentVersion), true);
  assert.equal((await migrationStatus(admin)).length, migrationIds.length);
});

test('application grants exclude migration, identity, membership and provenance writes', async () => {
  await migratePostgres(admin);
  await grantApplicationRole(admin, appRole);
  const attributes = (await application.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.deepEqual(attributes, { rolsuper: false, rolbypassrls: false });
  await assert.rejects(application.query('SELECT * FROM uap.schema_migrations'), { code: '42501' });
  await assert.rejects(application.query("INSERT INTO uap.users VALUES ('forbidden','x@example.test','Forbidden',1)"), { code: '42501' });
  await assert.rejects(application.query("DELETE FROM uap.memberships"), { code: '42501' });
  await assert.rejects(application.query('TRUNCATE uap.agents'), { code: '42501' });
  await assert.rejects(application.query('DELETE FROM uap.conversations'), { code: '42501' });
  await assert.rejects(application.query('DELETE FROM uap.message_rows'), { code: '42501' });
  await assert.rejects(application.query('UPDATE uap.llm_items SET item=item'), { code: '42501' });
  await assert.rejects(application.query("CREATE TABLE uap.forbidden(id text)"), { code: '42501' });
  assert.deepEqual((await application.query('SELECT * FROM uap.agents')).rows, []);
  const migrator = (await admin.query('SELECT current_user AS name')).rows[0].name;
  await assert.rejects(grantApplicationRole(admin, migrator), /must not have elevated|must not inherit|must not.*own/);
  await assert.rejects(grantApplicationRole(admin, 'missing_application_role_fixture'), /must exist/);
});

test('inherited broad read or CREATEDB privileges cannot masquerade as a least-privileged application role', async () => {
  await migratePostgres(admin);
  await admin.query(`GRANT pg_read_all_data TO ${quotedAppRole}`);
  try {
    await assert.rejects(grantApplicationRole(admin, appRole), /inherits unsupported schema\/table privileges/);
  } finally { await admin.query(`REVOKE pg_read_all_data FROM ${quotedAppRole}`); }
  const group = `${appRole}_dbgroup`;
  const quotedGroup = `"${group.replaceAll('"', '""')}"`;
  await admin.query(`CREATE ROLE ${quotedGroup} NOLOGIN CREATEDB`);
  try {
    await admin.query(`GRANT ${quotedGroup} TO ${quotedAppRole}`);
    await assert.rejects(grantApplicationRole(admin, appRole), /must not inherit an elevated role/);
  } finally {
    await admin.query(`REVOKE ${quotedGroup} FROM ${quotedAppRole}`);
    await admin.query(`DROP ROLE ${quotedGroup}`);
  }
});


test('a blocked migration lock times out without leaving a schema or an unusable pool client', { timeout: 15000 }, async () => {
  const holder = await admin.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(21442,1)');
    await assert.rejects(migratePostgres(admin), { code: '55P03' });
    assert.equal((await admin.query("SELECT to_regnamespace('uap') IS NULL AS absent")).rows[0].absent, true);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  assert.deepEqual(await migratePostgres(admin), { applied: migrationIds, currentVersion });
});


test('upgrade from migration one preserves existing identities, agent metadata and applied checksums', async () => {
  await migratePostgres(admin, POSTGRES_MIGRATIONS.slice(0, 1));
  const initialLedger = await migrationStatus(admin);
  await admin.query("INSERT INTO uap.users VALUES ('upgrade-user','upgrade@example.test','Upgrade owner',10)");
  await admin.query("INSERT INTO uap.organizations VALUES ('upgrade-org','upgrade-org','Upgrade organization',10)");
  await admin.query("INSERT INTO uap.memberships VALUES ('upgrade-org','upgrade-user','owner','active',10)");
  await admin.query("INSERT INTO uap.workspaces VALUES ('upgrade-space','upgrade-org','Upgrade workspace',11)");
  await admin.query(`INSERT INTO uap.agents(id,organization_id,workspace_id,owner_user_id,name,profile,created_at,updated_at)
    VALUES ('upgrade-agent','upgrade-org','upgrade-space','upgrade-user','Original agent','{"instructions":"Retain metadata"}',12,12)`);
  const oldUser = (await admin.query('SELECT * FROM uap.users')).rows;
  const oldAgent = (await admin.query('SELECT * FROM uap.agents')).rows;
  assert.deepEqual(await migratePostgres(admin), { applied: migrationIds.slice(1), currentVersion });
  assert.deepEqual((await migrationStatus(admin)).slice(0, 1), initialLedger);
  assert.deepEqual((await admin.query('SELECT * FROM uap.users')).rows, oldUser);
  assert.deepEqual((await admin.query('SELECT * FROM uap.agents')).rows, oldAgent);
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM uap.conversations')).rows[0].count, 0);
  assert.deepEqual(await migratePostgres(admin), { applied: [], currentVersion });
});
