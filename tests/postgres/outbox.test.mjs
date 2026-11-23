// Transactional outbox for the single durable task queue (V6-06-03).
// Negative paths first: an uncommitted event must never be deliverable, a stale
// relay must never mark (or release) a row it does not hold, and a dead-lettered
// row must never be claimable again.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { migratePostgres, grantApplicationRole } from '../../server/src/storage/postgres/migrations.ts';
import { grantJobWorkerRole } from '../../server/src/storage/postgres/job-worker-grants.ts';
import { TenantJobRepository } from '../../server/src/storage/postgres/jobs.ts';

if (process.env.UAP_POSTGRES_TEST_DATABASE !== '1' || !process.env.TEST_DATABASE_URL ||
    !process.env.TEST_WORKER_DATABASE_URL) {
  throw new Error('Run PostgreSQL outbox tests through the disposable database harness.');
}

const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
const application = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL, max: 4 });
const worker = new Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 4 });
const tenant = new TenantJobRepository(application);
const prefix = `outbox_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const id = name => `${prefix}_${name}`;
const owner = id('owner');
const org = id('org');
const space = id('space');
const scope = { actorId: owner, organizationId: org };
let sequence = 0;

before(async () => {
  await migratePostgres(admin);
  await grantApplicationRole(admin, decodeURIComponent(new URL(process.env.TEST_APP_DATABASE_URL).username));
  await grantJobWorkerRole(admin, decodeURIComponent(new URL(process.env.TEST_WORKER_DATABASE_URL).username));
  const now = Date.now();
  await admin.query('INSERT INTO uap.users VALUES ($1,$2,$3,$4)', [owner, `${owner}@example.test`, owner, now]);
  await admin.query('INSERT INTO uap.organizations VALUES ($1,$1,$1,$2)', [org, now]);
  await admin.query("INSERT INTO uap.memberships VALUES ($1,$2,'owner','active',$3)", [org, owner, now]);
  await admin.query('INSERT INTO uap.workspaces VALUES ($1,$2,$1,$3)', [space, org, now]);
});
after(async () => { await worker.end(); await application.end(); await admin.end(); });

async function enqueue(name) {
  const n = ++sequence;
  const agentId = id(`agent_${name}_${n}`);
  await admin.query(`INSERT INTO uap.agents(id,organization_id,workspace_id,owner_user_id,name,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$1,1,1)`, [agentId, org, space, owner]);
  const result = await tenant.enqueue(scope, {
    workspaceId: space, agentId, title: name, kind: `outbox.${name}.${n}`,
    payload: { input: name }, idempotencyKey: id(`key_${n}`),
  });
  return result;
}

const claimOutbox = async (relayId, limit = 10, lockMs = 30_000) =>
  (await admin.query('SELECT * FROM uap.claim_job_outbox($1,$2,$3)', [relayId, limit, lockMs])).rows;

test('an event that never commits produces no outbox row, so nothing can be delivered before the state change lands', async () => {
  const stored = await enqueue('rollback');
  const client = await admin.connect();
  const ghost = `evt_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO uap.job_events(
      event_id,organization_id,job_id,task_id,workspace_id,agent_id,seq,event_type,
      actor_type,actor_id,trace_id,created_at)
      SELECT $1,organization_id,id,task_id,workspace_id,agent_id,next_event_seq,'test.ghost',
        'system','rollback_test',trace_id,created_at
      FROM uap.task_jobs WHERE organization_id=$2 AND id=$3`,
    [ghost, org, stored.job.id]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM uap.job_outbox WHERE event_id=$1', [ghost])).rows[0].n, 1);
    await client.query('ROLLBACK');
  } finally { client.release(); }
  const after = await admin.query('SELECT count(*)::int AS n FROM uap.job_outbox WHERE event_id=$1', [ghost]);
  assert.equal(after.rows[0].n, 0, 'rolled-back event left an outbox row');
  const events = await admin.query('SELECT count(*)::int AS n FROM uap.job_events WHERE event_id=$1', [ghost]);
  assert.equal(events.rows[0].n, 0);
});

test('a committed transition writes exactly one outbox row carrying the event payload', async () => {
  const stored = await enqueue('committed');
  const rows = await admin.query(`SELECT outbox.event_id, outbox.organization_id, outbox.job_id, outbox.seq,
      outbox.event_type, outbox.attempts, outbox.published_at, outbox.dead_lettered_at,
      event.payload AS event_payload, event.trace_id AS event_trace_id
    FROM uap.job_outbox AS outbox
    JOIN uap.job_events AS event
      ON event.organization_id=outbox.organization_id AND event.event_id=outbox.event_id
    WHERE outbox.organization_id=$1 AND outbox.job_id=$2`,
  [org, stored.job.id]);
  assert.equal(rows.rowCount, 1);
  const row = rows.rows[0];
  assert.equal(row.event_type, 'job.queued');
  assert.equal(Number(row.seq), 1);
  assert.equal(row.attempts, 0);
  assert.equal(row.published_at, null);
  assert.equal(row.dead_lettered_at, null);

  const claimed = (await claimOutbox('relay_a', 500)).find(entry => entry.event_id === row.event_id);
  assert.ok(claimed, 'committed event was not claimable');
  assert.equal(claimed.event_type, 'job.queued');
  assert.deepEqual(claimed.payload, row.event_payload);
  assert.equal(claimed.trace_id, row.event_trace_id);
});

test('a delivery lease is exclusive: a second relay cannot claim a locked row until the lock expires', async () => {
  const stored = await enqueue('exclusive');
  const mine = (await claimOutbox('relay_a', 500)).find(entry => entry.job_id === stored.job.id);
  assert.ok(mine, 'first relay did not get the row');
  const other = await claimOutbox('relay_b', 500);
  assert.equal(other.some(entry => entry.event_id === mine.event_id), false, 'locked row was handed to a second relay');

  await admin.query("UPDATE uap.job_outbox SET locked_until=1 WHERE event_id=$1", [mine.event_id]);
  const recovered = await claimOutbox('relay_b', 500);
  assert.ok(recovered.some(entry => entry.event_id === mine.event_id), 'expired lock was not recoverable');
});

test('a stale relay cannot mark or release a row it does not hold', async () => {
  const stored = await enqueue('stale');
  const claimed = (await claimOutbox('relay_a', 500)).find(entry => entry.job_id === stored.job.id);
  assert.ok(claimed);

  const wrong = await admin.query('SELECT uap.mark_job_outbox_published($1,$2) AS ok', [claimed.event_id, 'relay_b']);
  assert.equal(wrong.rows[0].ok, false);
  const released = await admin.query('SELECT uap.release_job_outbox($1,$2,$3,$4,$5) AS state',
    [claimed.event_id, 'relay_b', 1000, 'stale attempt', 3]);
  assert.equal(released.rows[0].state, 'stale');

  const row = await admin.query('SELECT attempts,published_at,dead_lettered_at,locked_by FROM uap.job_outbox WHERE event_id=$1',
    [claimed.event_id]);
  assert.equal(row.rows[0].attempts, 0);
  assert.equal(row.rows[0].published_at, null);
  assert.equal(row.rows[0].dead_lettered_at, null);
  assert.equal(row.rows[0].locked_by, 'relay_a');

  const ok = await admin.query('SELECT uap.mark_job_outbox_published($1,$2) AS ok', [claimed.event_id, 'relay_a']);
  assert.equal(ok.rows[0].ok, true);
  assert.equal((await claimOutbox('relay_a', 500)).some(entry => entry.event_id === claimed.event_id), false,
    'a published row was claimable again');
});

test('failed delivery retries with backoff and dead-letters at the attempt ceiling, never republishing', async () => {
  const stored = await enqueue('dead');
  const eventId = (await admin.query('SELECT event_id FROM uap.job_outbox WHERE organization_id=$1 AND job_id=$2',
    [org, stored.job.id])).rows[0].event_id;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claimed = (await claimOutbox('relay_a', 500)).find(entry => entry.event_id === eventId);
    assert.ok(claimed, `row was not claimable on attempt ${attempt}`);
    const outcome = await admin.query('SELECT uap.release_job_outbox($1,$2,$3,$4,$5) AS state',
      [claimed.event_id, 'relay_a', 1, `publisher failure ${attempt}`, 3]);
    assert.equal(outcome.rows[0].state, attempt < 3 ? 'retry' : 'dead');
  }
  const row = await admin.query('SELECT attempts,dead_lettered_at,last_error FROM uap.job_outbox WHERE event_id=$1', [eventId]);
  assert.equal(row.rows[0].attempts, 3);
  assert.ok(row.rows[0].dead_lettered_at !== null);
  assert.equal(row.rows[0].last_error, 'publisher failure 3');
  assert.equal((await claimOutbox('relay_a', 500)).some(entry => entry.job_id === stored.job.id), false,
    'a dead-lettered row was claimable again');
});

test('the worker login may execute outbox functions but cannot read or write the outbox table', async () => {
  await assert.rejects(worker.query('SELECT * FROM uap.job_outbox LIMIT 1'), { code: '42501' });
  await assert.rejects(worker.query("UPDATE uap.job_outbox SET attempts=0"), { code: '42501' });
  const ok = await worker.query('SELECT * FROM uap.job_outbox_state()');
  assert.equal(ok.rowCount, 1);
  assert.equal(typeof ok.rows[0].pending, 'string');
});

test('outbox state reports pending, locked, published and dead rows truthfully', async () => {
  await enqueue('state');
  const state = (await admin.query('SELECT * FROM uap.job_outbox_state()')).rows[0];
  const counts = (await admin.query(`SELECT
      count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)::int AS pending,
      count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL AND locked_by IS NOT NULL)::int AS locked,
      count(*) FILTER (WHERE published_at IS NOT NULL)::int AS published,
      count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead
    FROM uap.job_outbox`)).rows[0];
  assert.equal(Number(state.pending), counts.pending);
  assert.equal(Number(state.locked), counts.locked);
  assert.equal(Number(state.published), counts.published);
  assert.equal(Number(state.dead_lettered), counts.dead);
  assert.ok(state.oldest_pending_age_ms === null || Number(state.oldest_pending_age_ms) >= 0);
});
