// Real PostgreSQL role-boundary tests. The harness creates a fresh database and
// independent application, session-issuer and worker logins for this file.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { withTenant, UnsafeDatabaseRoleError } from '../../server/src/storage/postgres/connection.ts';
import { migratePostgres, grantApplicationRole } from '../../server/src/storage/postgres/migrations.ts';
import { grantSessionIssuerRole } from '../../server/src/storage/postgres/session-grants.ts';
import {
  assertJobWorkerRole,
  grantJobWorkerRole,
  UnsafeJobWorkerRoleError,
} from '../../server/src/storage/postgres/job-worker-grants.ts';

if (process.env.UAP_POSTGRES_TEST_DATABASE !== '1' || !process.env.TEST_DATABASE_URL ||
    !process.env.TEST_APP_DATABASE_URL || !process.env.TEST_ISSUER_DATABASE_URL ||
    !process.env.TEST_WORKER_DATABASE_URL) {
  throw new Error('Run PostgreSQL worker tests through the disposable database harness.');
}

const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
const application = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL, max: 1 });
const issuer = new Pool({ connectionString: process.env.TEST_ISSUER_DATABASE_URL, max: 1 });
const worker = new Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 1 });
const roleFrom = value => decodeURIComponent(new URL(value).username);
const appRole = roleFrom(process.env.TEST_APP_DATABASE_URL);
const issuerRole = roleFrom(process.env.TEST_ISSUER_DATABASE_URL);
const workerRole = roleFrom(process.env.TEST_WORKER_DATABASE_URL);
const quote = value => `"${value.replaceAll('"', '""')}"`;
const quotedWorker = quote(workerRole);
const allowedFunctions = [
  'claim_job_outbox',
  'claim_task_job',
  'consume_task_approval',
  'heartbeat_task_job',
  'job_outbox_state',
  'mark_job_outbox_published',
  'release_job_outbox',
  'request_task_approval',
  'settle_task_job',
];

before(async () => {
  await migratePostgres(admin);
  await grantApplicationRole(admin, appRole);
  await grantSessionIssuerRole(admin, issuerRole);
  await grantJobWorkerRole(admin, workerRole);
});
after(async () => {
  await worker.end();
  await issuer.end();
  await application.end();
  await admin.end();
});

test('worker login has only fixed transition functions and no direct durable or identity table access', async () => {
  const client = await worker.connect();
  try { await assertJobWorkerRole(client); } finally { client.release(); }

  const functions = await worker.query(`
    SELECT function.proname AS name
    FROM pg_proc AS function JOIN pg_namespace AS namespace ON namespace.oid=function.pronamespace
    WHERE namespace.nspname='uap' AND has_function_privilege(current_user,function.oid,'EXECUTE')
    ORDER BY function.proname`);
  assert.deepEqual(functions.rows.map(row => row.name), allowedFunctions);

  for (const table of [
    'users', 'organizations', 'memberships', 'workspaces', 'agents', 'auth_sessions',
    'tasks', 'task_jobs', 'agent_runs', 'approvals', 'job_events', 'job_outbox', 'schema_migrations',
  ]) {
    await assert.rejects(worker.query(`SELECT * FROM uap.${table} LIMIT 1`), { code: '42501' });
  }
  await assert.rejects(worker.query("CREATE TABLE uap.worker_escape(id text)"), { code: '42501' });
  await assert.rejects(worker.query("SELECT * FROM uap.authenticate_session($1)", ['0'.repeat(64)]), { code: '42501' });
});

test('application, session issuer and migration owner cannot masquerade as the worker', async () => {
  for (const pool of [application, issuer, admin]) {
    const client = await pool.connect();
    try {
      await assert.rejects(assertJobWorkerRole(client), UnsafeJobWorkerRoleError);
    } finally { client.release(); }
  }
  await assert.rejects(grantJobWorkerRole(admin, appRole), UnsafeJobWorkerRoleError);
  await assert.rejects(grantJobWorkerRole(admin, issuerRole), UnsafeJobWorkerRoleError);
  await assert.rejects(grantJobWorkerRole(admin, 'missing_worker_role'), UnsafeJobWorkerRoleError);
});

test('grant provisioning refuses broad existing authority instead of erasing it', async () => {
  await admin.query(`GRANT SELECT ON uap.users TO ${quotedWorker}`);
  try {
    await assert.rejects(grantJobWorkerRole(admin, workerRole), UnsafeJobWorkerRoleError);
    assert.equal((await admin.query(
      'SELECT has_table_privilege($1,$2,$3) AS allowed', [workerRole, 'uap.users', 'SELECT'],
    )).rows[0].allowed, true, 'a rejected grant must not silently clean the role');
  } finally {
    await admin.query(`REVOKE SELECT ON uap.users FROM ${quotedWorker}`);
  }
  await grantJobWorkerRole(admin, workerRole);
  const client = await worker.connect();
  try { await assertJobWorkerRole(client); } finally { client.release(); }
});

test('runtime guard detects elevated, table, function and inherited privilege drift', async () => {
  const group = `${workerRole}_group`;
  const quotedGroup = quote(group);
  const changes = [
    [`ALTER ROLE ${quotedWorker} CREATEDB`, `ALTER ROLE ${quotedWorker} NOCREATEDB`],
    [`GRANT SELECT ON uap.schema_migrations TO ${quotedWorker}`, `REVOKE SELECT ON uap.schema_migrations FROM ${quotedWorker}`],
    [`GRANT EXECUTE ON FUNCTION uap.authenticate_session(text) TO ${quotedWorker}`, `REVOKE EXECUTE ON FUNCTION uap.authenticate_session(text) FROM ${quotedWorker}`],
  ];
  for (const [elevate, restore] of changes) {
    try {
      await admin.query(elevate);
      const client = await worker.connect();
      try { await assert.rejects(assertJobWorkerRole(client), UnsafeJobWorkerRoleError); }
      finally { client.release(); }
    } finally { await admin.query(restore); }
  }

  await admin.query(`CREATE ROLE ${quotedGroup} NOLOGIN NOINHERIT`);
  try {
    await admin.query(`GRANT SELECT ON uap.tasks TO ${quotedGroup}`);
    await admin.query(`GRANT ${quotedGroup} TO ${quotedWorker}`);
    const client = await worker.connect();
    try { await assert.rejects(assertJobWorkerRole(client), UnsafeJobWorkerRoleError); }
    finally { client.release(); }
  } finally {
    await admin.query(`REVOKE ${quotedGroup} FROM ${quotedWorker}`);
    await admin.query(`REVOKE SELECT ON uap.tasks FROM ${quotedGroup}`);
    await admin.query(`DROP ROLE ${quotedGroup}`);
  }

  const client = await worker.connect();
  try { await assertJobWorkerRole(client); } finally { client.release(); }
});

test('application execution helper or runtime write privilege drift fails before tenant work', async () => {
  const quotedApp = quote(appRole);
  const helper = (await admin.query(`SELECT oid::regprocedure::text AS identity FROM pg_proc
    WHERE pronamespace='uap'::regnamespace AND proname='append_task_job_event'`)).rows[0].identity;
  const changes = [
    ...['tasks','task_jobs','agent_runs','approvals','job_events'].map(table => [
      `GRANT UPDATE ON uap.${table} TO ${quotedApp}`, `REVOKE UPDATE ON uap.${table} FROM ${quotedApp}`,
    ]),
    [`GRANT EXECUTE ON FUNCTION ${helper} TO ${quotedApp}`, `REVOKE EXECUTE ON FUNCTION ${helper} FROM ${quotedApp}`],
  ];
  for (const [elevate, restore] of changes) {
    try {
      await admin.query(elevate);
      let entered = false;
      await assert.rejects(withTenant(application, {actorId:'unused',organizationId:'unused'}, async () => { entered=true; }), UnsafeDatabaseRoleError);
      assert.equal(entered, false);
    } finally { await admin.query(restore); }
  }
  await assert.rejects(grantApplicationRole(admin, workerRole), /separate credentials/);
});
// End of worker grant role-boundary tests.
