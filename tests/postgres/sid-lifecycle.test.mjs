// SID pause / resume / archive (V6-04-09). Lifecycle is a database-owned state
// machine: a paused agent keeps its identity and installation records, resumes
// from pause without minting a new SID, and an archived agent is read-only — it
// cannot be resumed back into service, only replaced through lineage.
//
// Negative paths first: a revoked SID is never resurrected, an archived SID does
// not resume, archiving twice is refused instead of appending a second event, a
// cross-tenant caller cannot pause someone else's agent, and the lifecycle log is
// append-only for the database itself, not only for the application login.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { migratePostgres, grantApplicationRole } from '../../server/src/storage/postgres/migrations.ts';
import { withTenant } from '../../server/src/storage/postgres/connection.ts';
import { issueSidInstance, readSidInstance } from '../../server/src/identity/sid.ts';
import {
  archiveSid,
  pauseSid,
  readSidLifecycle,
  resumeSid,
  SidLifecycleError,
} from '../../server/src/identity/lifecycle.ts';

if (process.env.UAP_POSTGRES_TEST_DATABASE !== '1' || !process.env.TEST_DATABASE_URL ||
    !process.env.TEST_APP_DATABASE_URL) {
  throw new Error('Run PostgreSQL SID lifecycle tests through the disposable database harness.');
}

const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
const application = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL, max: 2 });

const prefix = `sid_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const ownerA = `${prefix}_owner_a`;
const ownerB = `${prefix}_owner_b`;
const memberA = `${prefix}_member_a`;
const stranger = `${prefix}_stranger`;
const orgA = `${prefix}_org_a`;
const orgB = `${prefix}_org_b`;
const scopeA = { actorId: ownerA, organizationId: orgA };
const scopeB = { actorId: ownerB, organizationId: orgB };
const memberScope = { actorId: memberA, organizationId: orgA };
const roleTemplate = { id: `role_${prefix}`, version: 1, digest: 'c'.repeat(64) };
const REASON = 'operator paused the agent for review';

let sequence = 0;
const activation = (overrides = {}) => {
  sequence += 1;
  return {
    sid: `sid_${prefix}_${sequence}`,
    displayName: `Lifecycle Specialist ${sequence}`,
    roleTemplate,
    installation: { id: `inst_${prefix}_${sequence}`, ref: `host-${sequence}`, runtime: 'hermes' },
    model: { id: `model_${prefix}_${sequence}`, provider: 'local', model: 'qwen3-32b' },
    identityDocument: {
      format: 'uap-sid/0.2',
      name: `Lifecycle Specialist ${sequence}`,
      role: { template: roleTemplate.id, version: roleTemplate.version, digest: roleTemplate.digest },
    },
    ...overrides,
  };
};

/** Issues an identity on the application login, exactly as production activation does. */
async function activate(scope = scopeA) {
  const input = activation();
  await withTenant(application, scope, client => issueSidInstance(client, scope, input));
  return input.sid;
}

const run = (scope, fn) => withTenant(application, scope, client => fn(client, scope));

before(async () => {
  await migratePostgres(admin);
  await grantApplicationRole(admin, decodeURIComponent(new URL(process.env.TEST_APP_DATABASE_URL).username));
  const now = Date.now();
  for (const id of [ownerA, ownerB, memberA, stranger]) {
    await admin.query('INSERT INTO uap.users(id,email,name,created_at) VALUES ($1,$2,$1,$3)', [id, `${id}@example.test`, now]);
  }
  for (const [org, owner] of [[orgA, ownerA], [orgB, ownerB]]) {
    await admin.query('INSERT INTO uap.organizations(id,slug,name,created_at) VALUES ($1,$1,$1,$2)', [org, now]);
    await admin.query("INSERT INTO uap.memberships(organization_id,user_id,role,state,created_at) VALUES ($1,$2,'owner','active',$3)", [org, owner, now]);
  }
  await admin.query("INSERT INTO uap.memberships(organization_id,user_id,role,state,created_at) VALUES ($1,$2,'member','active',$3)", [orgA, memberA, now]);
});
after(async () => { await application.end(); await admin.end(); });

test('pausing keeps the SID and its identity hash and appends one event', async () => {
  const sid = await activate();
  const before = await admin.query('SELECT identity_hash,created_at FROM uap.sid_identities WHERE sid=$1', [sid]);

  const paused = await run(scopeA, (client, scope) => pauseSid(client, scope, { sid, reason: REASON }));
  assert.deepEqual(paused, { sid, status: 'paused', affectedInstallations: 0 });

  const row = await admin.query('SELECT status,identity_hash FROM uap.sid_identities WHERE sid=$1', [sid]);
  assert.equal(row.rows[0].status, 'paused');
  assert.equal(row.rows[0].identity_hash, before.rows[0].identity_hash);

  const events = await run(scopeA, (client, scope) => readSidLifecycle(client, scope, sid));
  assert.equal(events.length, 1);
  const [event] = events;
  assert.deepEqual(
    [event.seq, event.eventType, event.fromStatus, event.toStatus, event.reason, event.actorId],
    [1, 'paused', 'active', 'paused', REASON, ownerA],
  );
  assert.equal(typeof event.occurredAt, 'number');
  assert.ok(event.occurredAt > before.rows[0].created_at);
});

test('resuming a paused SID restores it without re-issuing anything', async () => {
  const sid = await activate();
  await run(scopeA, (client, scope) => pauseSid(client, scope, { sid, reason: REASON }));
  const resumed = await run(scopeA, (client, scope) => resumeSid(client, scope, { sid }));
  assert.deepEqual(resumed, { sid, status: 'active', affectedInstallations: 0 });

  const counts = await admin.query(`SELECT
      (SELECT count(*)::int FROM uap.sid_identities WHERE sid=$1) AS sids,
      (SELECT count(*)::int FROM uap.agent_installations WHERE sid=$1) AS installations`, [sid]);
  assert.deepEqual(counts.rows[0], { sids: 1, installations: 1 });

  const events = await run(scopeA, (client, scope) => readSidLifecycle(client, scope, sid));
  assert.deepEqual(events.map(event => [event.seq, event.eventType, event.fromStatus, event.toStatus]),
    [[1, 'paused', 'active', 'paused'], [2, 'resumed', 'paused', 'active']]);
});

test('an active SID cannot be resumed and a paused SID cannot be paused twice', async () => {
  const sid = await activate();
  await assert.rejects(
    run(scopeA, (client, scope) => resumeSid(client, scope, { sid })),
    error => error instanceof SidLifecycleError && error.code === 'sid_not_paused',
  );

  await run(scopeA, (client, scope) => pauseSid(client, scope, { sid, reason: REASON }));
  await assert.rejects(
    run(scopeA, (client, scope) => pauseSid(client, scope, { sid, reason: REASON })),
    error => error instanceof SidLifecycleError && error.code === 'sid_not_active',
  );
  const events = await run(scopeA, (client, scope) => readSidLifecycle(client, scope, sid));
  assert.equal(events.length, 1);
});

test('archiving removes the live installations and freezes the identity', async () => {
  const sid = await activate();
  const archived = await run(scopeA, (client, scope) => archiveSid(client, scope, { sid, reason: 'role retired' }));
  assert.deepEqual(archived, { sid, status: 'archived', affectedInstallations: 1 });

  const states = await admin.query('SELECT state FROM uap.agent_installations WHERE sid=$1', [sid]);
  assert.deepEqual(states.rows, [{ state: 'removed' }]);
  const events = await run(scopeA, (client, scope) => readSidLifecycle(client, scope, sid));
  assert.deepEqual(events.map(event => event.eventType), ['archived']);
});

test('an archived SID never resumes and is not archived twice', async () => {
  const sid = await activate();
  await run(scopeA, (client, scope) => archiveSid(client, scope, { sid, reason: 'role retired' }));

  await assert.rejects(
    run(scopeA, (client, scope) => resumeSid(client, scope, { sid })),
    error => error instanceof SidLifecycleError && error.code === 'sid_archived',
  );
  await assert.rejects(
    run(scopeA, (client, scope) => pauseSid(client, scope, { sid, reason: REASON })),
    error => error instanceof SidLifecycleError && error.code === 'sid_archived',
  );
  await assert.rejects(
    run(scopeA, (client, scope) => archiveSid(client, scope, { sid, reason: 'again' })),
    error => error instanceof SidLifecycleError && error.code === 'sid_already_archived',
  );
  const row = await admin.query('SELECT status FROM uap.sid_identities WHERE sid=$1', [sid]);
  assert.equal(row.rows[0].status, 'archived');
});

test('a revoked SID is not resurrected by pause, resume or archive', async () => {
  const sid = await activate();
  // Revocation itself is D-14's authority; this test only pins the lifecycle
  // guard against the revoked state the database can already hold.
  await admin.query("UPDATE uap.sid_identities SET status='revoked' WHERE sid=$1", [sid]);

  for (const attempt of [
    (client, scope) => pauseSid(client, scope, { sid, reason: REASON }),
    (client, scope) => resumeSid(client, scope, { sid }),
    (client, scope) => archiveSid(client, scope, { sid, reason: 'cleanup' }),
  ]) {
    await assert.rejects(
      run(scopeA, attempt),
      error => error instanceof SidLifecycleError && error.code === 'sid_revoked',
    );
  }
  const row = await admin.query('SELECT status FROM uap.sid_identities WHERE sid=$1', [sid]);
  assert.equal(row.rows[0].status, 'revoked');
});

test('lifecycle transitions require a reason and refuse a foreign tenant', async () => {
  const sid = await activate();
  await assert.rejects(
    run(scopeA, (client, scope) => pauseSid(client, scope, { sid, reason: '' })),
    error => error instanceof SidLifecycleError && error.code === 'input_invalid',
  );
  await assert.rejects(
    run(scopeA, (client, scope) => pauseSid(client, scope, { sid, reason: 'x'.repeat(501) })),
    error => error instanceof SidLifecycleError && error.code === 'input_invalid',
  );

  // Another tenant's owner gets "missing", never confirmation that the SID exists,
  // and the record is untouched by the attempt.
  await assert.rejects(
    run(scopeB, (client, scope) => pauseSid(client, scope, { sid, reason: REASON })),
    error => error instanceof SidLifecycleError && error.code === 'sid_missing',
  );
  const row = await admin.query('SELECT status FROM uap.sid_identities WHERE sid=$1', [sid]);
  assert.equal(row.rows[0].status, 'active');

  // The database function's own branch is what refuses a caller whose session
  // organization does not match the argument.
  await assert.rejects(
    run(scopeA, (client, scope) => pauseSid(client, { ...scope, organizationId: orgB }, { sid, reason: REASON })),
    error => error instanceof SidLifecycleError && error.code === 'tenant_forbidden',
  );
  await assert.rejects(
    pauseSid(null, { organizationId: orgA }, { sid: 'NOT-A-SID', reason: REASON }),
    error => error instanceof SidLifecycleError && error.code === 'input_invalid',
  );
});

test('a member may pause and resume but only an owner or admin may archive', async () => {
  const sid = await activate();
  await run(memberScope, (client, scope) => pauseSid(client, scope, { sid, reason: REASON }));
  await run(memberScope, (client, scope) => resumeSid(client, scope, { sid }));
  await assert.rejects(
    run(memberScope, (client, scope) => archiveSid(client, scope, { sid, reason: 'retire' })),
    error => error instanceof SidLifecycleError && error.code === 'tenant_forbidden',
  );
  const row = await admin.query('SELECT status FROM uap.sid_identities WHERE sid=$1', [sid]);
  assert.equal(row.rows[0].status, 'active');
});

test('the lifecycle log is append-only even for the database owner', async () => {
  const sid = await activate();
  await run(scopeA, (client, scope) => pauseSid(client, scope, { sid, reason: REASON }));

  await assert.rejects(
    admin.query('UPDATE uap.sid_lifecycle_events SET reason=$2 WHERE sid=$1', [sid, 'rewritten']),
    error => error.code === '42501' && String(error.message).includes('sid_lifecycle_events_append_only'),
  );
  await assert.rejects(
    admin.query('DELETE FROM uap.sid_lifecycle_events WHERE sid=$1', [sid]),
    error => error.code === '42501' && String(error.message).includes('sid_lifecycle_events_append_only'),
  );

  // The application login holds SELECT only, and RLS has no update policy: a
  // rewrite attempt is refused by the database rather than by convention.
  const canWrite = await withTenant(application, scopeA, client => client.query(
    "SELECT has_table_privilege(current_user,'uap.sid_lifecycle_events','INSERT,UPDATE,DELETE') AS can").then(r => r.rows[0].can));
  assert.equal(canWrite, false);
  await assert.rejects(withTenant(application, scopeA, client => client.query(
    "UPDATE uap.sid_lifecycle_events SET reason='rewritten' WHERE sid=$1", [sid])));
});

test('lifecycle events are tenant-scoped: another tenant reads none of them', async () => {
  const sid = await activate();
  await run(scopeA, (client, scope) => pauseSid(client, scope, { sid, reason: REASON }));

  assert.equal((await run(scopeA, (client, scope) => readSidLifecycle(client, scope, sid))).length, 1);
  assert.deepEqual(await run(scopeB, (client, scope) => readSidLifecycle(client, scope, sid)), []);
  assert.equal(await run(scopeB, (client, scope) => readSidInstance(client, sid)), null);
});
