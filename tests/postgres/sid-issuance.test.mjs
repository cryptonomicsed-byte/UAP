// Per-instance SID issuance (V6-04-03/04/06). The SID is the persistent
// principal of one activated specialist instance — not of a prompt, a source
// repo or a job — and its record is separate from the installation, the role
// template version and the Hermes model selection.
//
// Negative paths first: a SID minted for one tenant cannot be claimed by another,
// the same SID is never issued twice, a moved role template version is refused,
// and the application login cannot read across tenants.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { migratePostgres, grantApplicationRole } from '../../server/src/storage/postgres/migrations.ts';
import { withTenant } from '../../server/src/storage/postgres/connection.ts';
import {
  issueSidInstance,
  readSidInstance,
  recordSidModelSelection,
  SidIssuanceError,
} from '../../server/src/identity/sid.ts';

if (process.env.UAP_POSTGRES_TEST_DATABASE !== '1' || !process.env.TEST_DATABASE_URL ||
    !process.env.TEST_APP_DATABASE_URL) {
  throw new Error('Run PostgreSQL SID tests through the disposable database harness.');
}

const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
const application = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL, max: 2 });

const prefix = `sid_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const ownerA = `${prefix}_owner_a`;
const ownerB = `${prefix}_owner_b`;
const stranger = `${prefix}_stranger`;
const orgA = `${prefix}_org_a`;
const orgB = `${prefix}_org_b`;
const scopeA = { actorId: ownerA, organizationId: orgA };
const scopeB = { actorId: ownerB, organizationId: orgB };
const roleTemplate = { id: `role_${prefix}`, version: 1, digest: 'a'.repeat(64) };

let sequence = 0;
const activation = (overrides = {}) => {
  sequence += 1;
  return {
    sid: `sid_${prefix}_${sequence}`,
    displayName: `Specialist ${sequence}`,
    roleTemplate,
    installation: { id: `inst_${prefix}_${sequence}`, ref: `host-${sequence}`, runtime: 'hermes' },
    model: { id: `model_${prefix}_${sequence}`, provider: 'local', model: 'qwen3-32b', epoch: 1 },
    identityDocument: {
      format: 'uap-sid/0.2',
      name: `Specialist ${sequence}`,
      role: { template: roleTemplate.id, version: roleTemplate.version, digest: roleTemplate.digest },
    },
    ...overrides,
  };
};

before(async () => {
  await migratePostgres(admin);
  await grantApplicationRole(admin, decodeURIComponent(new URL(process.env.TEST_APP_DATABASE_URL).username));
  const now = Date.now();
  for (const id of [ownerA, ownerB, stranger]) {
    await admin.query('INSERT INTO uap.users(id,email,name,created_at) VALUES ($1,$2,$1,$3)', [id, `${id}@example.test`, now]);
  }
  for (const [org, owner] of [[orgA, ownerA], [orgB, ownerB]]) {
    await admin.query('INSERT INTO uap.organizations(id,slug,name,created_at) VALUES ($1,$1,$1,$2)', [org, now]);
    await admin.query("INSERT INTO uap.memberships(organization_id,user_id,role,state,created_at) VALUES ($1,$2,'owner','active',$3)", [org, owner, now]);
  }
});
after(async () => { await application.end(); await admin.end(); });

const issueAs = (scope, input) => withTenant(application, scope, client => issueSidInstance(client, scope, input));

// Drives the service on a raw application connection with the scope set locally,
// bypassing withTenant's membership precheck so the database function's own
// authorization branch is what refuses the call.
async function issueRaw(scope, input) {
  const client = await application.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('uap.actor_id',$1,true), set_config('uap.organization_id',$2,true)",
      [scope.actorId, scope.organizationId]);
    const result = await issueSidInstance(client, scope, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

test('one activation issues one SID plus its own installation and model selection records', async () => {
  const input = activation();
  const issued = await issueAs(scopeA, input);

  assert.equal(issued.sid, input.sid);
  assert.equal(issued.installationId, input.installation.id);
  assert.equal(issued.modelSelectionId, input.model.id);
  assert.equal(issued.lineageVersion, 1);
  assert.match(issued.identityHash, /^[0-9a-f]{64}$/);

  const counts = await admin.query(`SELECT
      (SELECT count(*)::int FROM uap.sid_identities WHERE sid=$1) AS sids,
      (SELECT count(*)::int FROM uap.agent_installations WHERE installation_id=$2 AND sid=$1) AS installations,
      (SELECT count(*)::int FROM uap.hermes_model_selections WHERE model_selection_id=$3 AND sid=$1) AS selections,
      (SELECT count(*)::int FROM uap.role_template_versions WHERE organization_id=$4 AND role_template_id=$5 AND version=$6) AS versions`,
  [input.sid, input.installation.id, input.model.id, orgA, roleTemplate.id, roleTemplate.version]);
  assert.deepEqual(counts.rows[0], { sids: 1, installations: 1, selections: 1, versions: 1 });

  const row = await admin.query('SELECT status, model_selection_id, identity_document FROM uap.sid_identities WHERE sid=$1', [input.sid]);
  assert.equal(row.rows[0].status, 'active');
  assert.equal(row.rows[0].model_selection_id, input.model.id);
  assert.deepEqual(row.rows[0].identity_document, input.identityDocument);
});

test('the identity hash is derived from the stored document, never supplied by the caller', async () => {
  const input = activation();
  const issued = await issueAs(scopeA, input);
  const derived = await admin.query(
    "SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') AS hash", [input.identityDocument]);
  assert.equal(issued.identityHash, derived.rows[0].hash);

  // A tampered document is a different identity even when the SID is the same.
  const tampered = activation({ identityDocument: { ...input.identityDocument, name: 'Impostor' } });
  const second = await issueAs(scopeA, tampered);
  assert.notEqual(second.identityHash, issued.identityHash);
});

test('two activations of the same role get two SIDs that share the role template version', async () => {
  const first = await issueAs(scopeA, activation());
  const second = await issueAs(scopeA, activation());
  assert.notEqual(first.sid, second.sid);

  const shared = await admin.query(`SELECT count(*)::int AS n FROM uap.sid_identities
    WHERE sid=ANY($1::text[]) AND role_template_id=$2 AND role_template_version=$3 AND organization_id=$4`,
  [[first.sid, second.sid], roleTemplate.id, roleTemplate.version, orgA]);
  assert.equal(shared.rows[0].n, 2);
});

test('a SID minted for one tenant is refused to another and its record is untouched', async () => {
  const input = activation();
  const issued = await issueAs(scopeA, input);
  const before = await admin.query('SELECT identity_hash,status FROM uap.sid_identities WHERE sid=$1', [input.sid]);

  await assert.rejects(
    issueAs(scopeB, { ...activation(), sid: input.sid }),
    error => error instanceof SidIssuanceError && error.code === 'sid_foreign_tenant',
  );

  const after = await admin.query('SELECT organization_id,identity_hash,status FROM uap.sid_identities WHERE sid=$1', [input.sid]);
  assert.deepEqual(after.rows, [{ organization_id: orgA, identity_hash: before.rows[0].identity_hash, status: before.rows[0].status }]);
  assert.equal(issued.sid, input.sid);
});

test('the same SID is never issued twice in its own tenant', async () => {
  const input = activation();
  await issueAs(scopeA, input);
  await assert.rejects(
    issueAs(scopeA, { ...activation(), sid: input.sid }),
    error => error instanceof SidIssuanceError && error.code === 'sid_already_issued',
  );
});

test('issuance requires an active role in the tenant', async () => {
  await assert.rejects(
    issueRaw({ actorId: stranger, organizationId: orgA }, activation()),
    error => error instanceof SidIssuanceError && error.code === 'tenant_forbidden',
  );
});

test('an installation id is registered once', async () => {
  const input = activation();
  await issueAs(scopeA, input);
  const clash = activation({ installation: { ...input.installation } });
  await assert.rejects(
    issueAs(scopeA, clash),
    error => error instanceof SidIssuanceError && error.code === 'installation_exists',
  );
});

test('a moved role template version is refused instead of silently re-bound', async () => {
  await issueAs(scopeA, { ...activation(), roleTemplate: { ...roleTemplate, id: `role2_${prefix}` } });
  await assert.rejects(
    issueAs(scopeA, activation({ roleTemplate: { id: `role2_${prefix}`, version: 1, digest: 'b'.repeat(64) } })),
    error => error instanceof SidIssuanceError && error.code === 'role_digest_mismatch',
  );
});

test('switching the Hermes model adds a selection and leaves the SID and its hash untouched', async () => {
  const input = activation();
  const issued = await issueAs(scopeA, input);
  const switched = await withTenant(application, scopeA, client => recordSidModelSelection(client, scopeA, {
    sid: input.sid,
    modelSelectionId: `${input.model.id}_v2`,
    provider: 'openrouter',
    model: 'gpt-5-mini',
  }));
  assert.equal(switched.epoch, 2);

  const row = await admin.query('SELECT identity_hash,model_selection_id FROM uap.sid_identities WHERE sid=$1', [input.sid]);
  assert.equal(row.rows[0].identity_hash, issued.identityHash);
  assert.equal(row.rows[0].model_selection_id, switched.modelSelectionId);

  const selections = await admin.query('SELECT model_selection_id FROM uap.hermes_model_selections WHERE sid=$1 ORDER BY epoch', [input.sid]);
  assert.deepEqual(selections.rows.map(r => r.model_selection_id), [input.model.id, switched.modelSelectionId]);
});

test('a lineage child records its parent and version without rewriting the parent', async () => {
  const parent = await issueAs(scopeA, activation());
  const child = await issueAs(scopeA, activation({ lineageParentId: parent.sid }));
  assert.equal(child.lineageVersion, 2);

  const rows = await admin.query('SELECT sid,lineage_parent_id,lineage_version FROM uap.sid_identities WHERE sid=ANY($1::text[]) ORDER BY lineage_version',
    [[parent.sid, child.sid]]);
  assert.deepEqual(rows.rows, [
    { sid: parent.sid, lineage_parent_id: null, lineage_version: 1 },
    { sid: child.sid, lineage_parent_id: parent.sid, lineage_version: 2 },
  ]);
});

test("another tenant's application login cannot read the SID", async () => {
  const input = activation();
  await issueAs(scopeA, input);

  assert.equal(await withTenant(application, scopeA, client => readSidInstance(client, input.sid)).then(r => r?.sid), input.sid);
  assert.equal(await withTenant(application, scopeB, client => readSidInstance(client, input.sid)), null);

  const raw = await withTenant(application, scopeB, client =>
    client.query('SELECT count(*)::int AS n FROM uap.sid_identities WHERE sid=$1', [input.sid]).then(r => r.rows[0].n));
  assert.equal(raw, 0);
});
