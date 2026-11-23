// SID authority: issuer keys, signed credentials, revocation and ownership
// transfer (V6-04-05). Negative paths first: an untrusted or revoked key cannot
// attest, a credential cannot claim a different identity hash, a revoked SID can
// never be re-signed or transferred, and a transfer moves control without
// rewriting the identity hash it was issued with.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { migratePostgres, grantApplicationRole } from '../../server/src/storage/postgres/migrations.ts';
import { withTenant } from '../../server/src/storage/postgres/connection.ts';
import { issueSidInstance } from '../../server/src/identity/sid.ts';
import {
  credentialPayload, publicKeyBase64, signCredential,
} from '../../server/src/identity/issuer.ts';
import {
  acceptSidTransfer,
  recordSidCredential,
  registerSidIssuer,
  requestSidTransfer,
  revokeSidIdentity,
  setSidIssuerStatus,
  verifySidCredential,
  SidAuthorityError,
} from '../../server/src/identity/sid-authority.ts';

if (process.env.UAP_POSTGRES_TEST_DATABASE !== '1' || !process.env.TEST_DATABASE_URL ||
    !process.env.TEST_APP_DATABASE_URL) {
  throw new Error('Run PostgreSQL SID authority tests through the disposable database harness.');
}

const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
const application = new Pool({ connectionString: process.env.TEST_APP_DATABASE_URL, max: 2 });

const prefix = `auth_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const users = { ownerA: `${prefix}_owner_a`, memberA: `${prefix}_member_a`, ownerB: `${prefix}_owner_b`, memberB: `${prefix}_member_b` };
const orgs = { a: `${prefix}_org_a`, b: `${prefix}_org_b` };
const scope = { aOwner: { actorId: users.ownerA, organizationId: orgs.a }, aMember: { actorId: users.memberA, organizationId: orgs.a }, bOwner: { actorId: users.ownerB, organizationId: orgs.b }, bMember: { actorId: users.memberB, organizationId: orgs.b } };
const keys = { a: generateKeyPairSync('ed25519'), b: generateKeyPairSync('ed25519'), a2: generateKeyPairSync('ed25519') };
const keyIds = { a: `key_a_${prefix}`, b: `key_b_${prefix}`, a2: `key_a2_${prefix}` };
const roleTemplate = { id: `role_${prefix}`, version: 1, digest: 'c'.repeat(64) };

let sequence = 0;
const activation = (overrides = {}) => {
  sequence += 1;
  return {
    sid: `sid_${prefix}_${sequence}`,
    displayName: `Specialist ${sequence}`,
    roleTemplate,
    installation: { id: `inst_${prefix}_${sequence}`, ref: `host-${sequence}`, runtime: 'hermes' },
    model: { id: `model_${prefix}_${sequence}`, provider: 'local', model: 'qwen3-32b', epoch: 1 },
    identityDocument: { format: 'uap-sid/0.2', name: `Specialist ${sequence}`, role: { template: roleTemplate.id, version: 1, digest: roleTemplate.digest } },
    ...overrides,
  };
};
const issue = (tenant, input) => withTenant(application, tenant, client => issueSidInstance(client, tenant, input));

/** Signs and records a credential for an issued SID. */
async function attest(tenant, issued, overrides = {}) {
  const fields = {
    sid: issued.sid,
    organizationId: tenant.organizationId,
    identityHash: issued.identityHash,
    keyId: overrides.keyId ?? keyIds[tenant === scope.aOwner || tenant === scope.aMember ? 'a' : 'b'],
    issuedAt: overrides.issuedAt ?? Date.now(),
    supersedes: overrides.supersedes ?? null,
  };
  const payload = credentialPayload(fields);
  const pair = fields.keyId === keyIds.b ? keys.b : fields.keyId === keyIds.a2 ? keys.a2 : keys.a;
  const credentialId = overrides.credentialId ?? `cred_${randomUUID().slice(0, 12)}`;
  const signature = overrides.signature ?? signCredential(pair.privateKey, payload);
  const recorded = await withTenant(application, tenant, client => recordSidCredential(client, tenant, {
    credentialId, sid: issued.sid, keyId: fields.keyId, issuedAt: fields.issuedAt, signature, supersedes: fields.supersedes,
  }));
  return { ...fields, credentialId, signature, recorded };
}

before(async () => {
  await migratePostgres(admin);
  await grantApplicationRole(admin, decodeURIComponent(new URL(process.env.TEST_APP_DATABASE_URL).username));
  const now = Date.now();
  for (const id of Object.values(users)) await admin.query('INSERT INTO uap.users(id,email,name,created_at) VALUES ($1,$2,$1,$3)', [id, `${id}@example.test`, now]);
  for (const [org, owner] of [[orgs.a, users.ownerA], [orgs.b, users.ownerB]]) {
    await admin.query('INSERT INTO uap.organizations(id,slug,name,created_at) VALUES ($1,$1,$1,$2)', [org, now]);
    await admin.query("INSERT INTO uap.memberships(organization_id,user_id,role,state,created_at) VALUES ($1,$2,'owner','active',$3)", [org, owner, now]);
  }
  await admin.query("INSERT INTO uap.memberships(organization_id,user_id,role,state,created_at) VALUES ($1,$2,'member','active',$3)", [orgs.a, users.memberA, now]);
  await admin.query("INSERT INTO uap.memberships(organization_id,user_id,role,state,created_at) VALUES ($1,$2,'member','active',$3)", [orgs.b, users.memberB, now]);
  await withTenant(application, scope.aOwner, client => registerSidIssuer(client, scope.aOwner, { issuerId: `issuer_a_${prefix}`, keyId: keyIds.a, publicKey: publicKeyBase64(keys.a.publicKey) }));
  await withTenant(application, scope.aOwner, client => registerSidIssuer(client, scope.aOwner, { issuerId: `issuer_a2_${prefix}`, keyId: keyIds.a2, publicKey: publicKeyBase64(keys.a2.publicKey) }));
  await withTenant(application, scope.bOwner, client => registerSidIssuer(client, scope.bOwner, { issuerId: `issuer_b_${prefix}`, keyId: keyIds.b, publicKey: publicKeyBase64(keys.b.publicKey) }));
});
after(async () => { await application.end(); await admin.end(); });

test('a trusted issuer key attests a credential that verifies from the stored row', async () => {
  const issued = await issue(scope.aOwner, activation());
  const cred = await attest(scope.aOwner, issued);
  const verified = await withTenant(application, scope.aOwner, client => verifySidCredential(client, issued.sid));
  assert.equal(verified.valid, true);
  assert.equal(verified.keyId, keyIds.a);
  assert.equal(verified.credentialId, cred.credentialId);
});

test('a signature over a different identity hash is refused before it is stored', async () => {
  const issued = await issue(scope.aOwner, activation());
  const wrong = signCredential(keys.a.privateKey, credentialPayload({
    sid: issued.sid, organizationId: orgs.a, identityHash: 'b'.repeat(64), keyId: keyIds.a, issuedAt: Date.now(), supersedes: null,
  }));
  await assert.rejects(
    attest(scope.aOwner, issued, { signature: wrong }),
    error => error instanceof SidAuthorityError && error.code === 'signature_invalid',
  );
  const count = await admin.query('SELECT count(*)::int AS n FROM uap.sid_credentials WHERE sid=$1', [issued.sid]);
  assert.equal(count.rows[0].n, 0);
});

test('a key that this tenant never registered cannot attest', async () => {
  const issued = await issue(scope.aOwner, activation());
  const rogue = generateKeyPairSync('ed25519');
  const payload = credentialPayload({ sid: issued.sid, organizationId: orgs.a, identityHash: issued.identityHash, keyId: `rogue_${prefix}`, issuedAt: Date.now(), supersedes: null });
  await assert.rejects(
    withTenant(application, scope.aOwner, client => recordSidCredential(client, scope.aOwner, {
      credentialId: `cred_${randomUUID().slice(0, 12)}`, sid: issued.sid, keyId: `rogue_${prefix}`, issuedAt: Date.now(),
      signature: signCredential(rogue.privateKey, payload), supersedes: null,
    })),
    error => error instanceof SidAuthorityError && error.code === 'issuer_untrusted',
  );
});

test('revoking an issuer key stops new attestations and marks existing ones untrusted', async () => {
  const issued = await issue(scope.aOwner, activation());
  const first = await attest(scope.aOwner, issued, { keyId: keyIds.a2 });
  await withTenant(application, scope.aOwner, client => setSidIssuerStatus(client, scope.aOwner, { keyId: keyIds.a2, status: 'revoked' }));
  const current = await withTenant(application, scope.aOwner, client => verifySidCredential(client, issued.sid));
  assert.equal(current.valid, false);
  assert.equal(current.reason, 'issuer_revoked');
  await assert.rejects(attest(scope.aOwner, issued, { keyId: keyIds.a2 }), error => error instanceof SidAuthorityError && error.code === 'issuer_revoked');

  // Recovery: a still-trusted key re-signs the same identity hash, superseding
  // the credential the revoked key issued; the old bytes and hash stay in place.
  const issuedAt = Date.now();
  const rotated = await withTenant(application, scope.aOwner, client => recordSidCredential(client, scope.aOwner, {
    credentialId: `cred_${randomUUID().slice(0, 12)}`, sid: issued.sid, keyId: keyIds.a, issuedAt,
    signature: signCredential(keys.a.privateKey, credentialPayload({ sid: issued.sid, organizationId: orgs.a, identityHash: issued.identityHash, keyId: keyIds.a, issuedAt, supersedes: first.credentialId })),
    supersedes: first.credentialId,
  }));
  assert.equal(rotated.identityHash, issued.identityHash);
  const recovered = await withTenant(application, scope.aOwner, client => verifySidCredential(client, issued.sid));
  assert.equal(recovered.valid, true);
  assert.equal(recovered.keyId, keyIds.a);
});

test('revocation is one-way: no re-signing and no second revocation', async () => {
  const issued = await issue(scope.aOwner, activation());
  await attest(scope.aOwner, issued);
  const revoked = await withTenant(application, scope.aOwner, client => revokeSidIdentity(client, scope.aOwner, { sid: issued.sid, reason: 'owner offboarding' }));
  assert.equal(revoked.status, 'revoked');
  const row = await admin.query('SELECT status FROM uap.sid_identities WHERE sid=$1', [issued.sid]);
  assert.equal(row.rows[0].status, 'revoked');

  await assert.rejects(
    withTenant(application, scope.aOwner, client => revokeSidIdentity(client, scope.aOwner, { sid: issued.sid, reason: 'again' })),
    error => error instanceof SidAuthorityError && error.code === 'already_revoked',
  );
  const at = await withTenant(application, scope.aOwner, client => verifySidCredential(client, issued.sid));
  assert.equal(at.valid, false);
  assert.equal(at.reason, 'sid_revoked');
});

test('a member cannot register issuer keys or revoke a SID', async () => {
  const issued = await issue(scope.aOwner, activation());
  await assert.rejects(
    withTenant(application, scope.aMember, client => registerSidIssuer(client, scope.aMember, { issuerId: `issuer_m_${prefix}`, keyId: `key_m_${prefix}`, publicKey: publicKeyBase64(generateKeyPairSync('ed25519').publicKey) })),
    error => error instanceof SidAuthorityError && error.code === 'issuer_forbidden',
  );
  await assert.rejects(
    withTenant(application, scope.aMember, client => revokeSidIdentity(client, scope.aMember, { sid: issued.sid, reason: 'nope' })),
    error => error instanceof SidAuthorityError && error.code === 'revoke_forbidden',
  );
});

test('ownership transfer moves control, keeps the identity hash and the old credential', async () => {
  const issued = await issue(scope.aOwner, activation());
  const original = await attest(scope.aOwner, issued);
  const transferId = `tr_${randomUUID().slice(0, 12)}`;
  await withTenant(application, scope.aOwner, client => requestSidTransfer(client, scope.aOwner, {
    transferId, sid: issued.sid, toOrganizationId: orgs.b, expiresAt: Date.now() + 3600_000,
  }));

  const memberIssuedAt = Date.now();
  await assert.rejects(
    withTenant(application, scope.bMember, client => acceptSidTransfer(client, scope.bMember, {
      transferId, credentialId: `cred_${randomUUID().slice(0, 12)}`, keyId: keyIds.b, issuedAt: memberIssuedAt,
      signature: signCredential(keys.b.privateKey, credentialPayload({ sid: issued.sid, organizationId: orgs.b, identityHash: issued.identityHash, keyId: keyIds.b, issuedAt: memberIssuedAt, supersedes: original.credentialId })),
    })),
    error => error instanceof SidAuthorityError && error.code === 'transfer_forbidden',
  );

  const issuedAt = Date.now();
  const accepted = await withTenant(application, scope.bOwner, client => acceptSidTransfer(client, scope.bOwner, {
    transferId, credentialId: `cred_new_${randomUUID().slice(0, 10)}`, keyId: keyIds.b, issuedAt,
    signature: signCredential(keys.b.privateKey, credentialPayload({ sid: issued.sid, organizationId: orgs.b, identityHash: issued.identityHash, keyId: keyIds.b, issuedAt, supersedes: original.credentialId })),
  }));
  assert.equal(accepted.sid, issued.sid);

  const moved = await admin.query('SELECT organization_id, identity_hash FROM uap.sid_identities WHERE sid=$1', [issued.sid]);
  assert.deepEqual(moved.rows[0], { organization_id: orgs.b, identity_hash: issued.identityHash });
  const counts = await admin.query(`SELECT
      (SELECT count(*)::int FROM uap.sid_credentials WHERE sid=$1) AS creds,
      (SELECT count(*)::int FROM uap.agent_installations WHERE sid=$1 AND organization_id=$2) AS installs,
      (SELECT count(*)::int FROM uap.role_template_versions WHERE organization_id=$2 AND role_template_id=$3 AND version=1) AS versions` , [issued.sid, orgs.b, roleTemplate.id]);
  assert.deepEqual(counts.rows[0], { creds: 2, installs: 1, versions: 1 });

  assert.equal(await withTenant(application, scope.aOwner, client => verifySidCredential(client, issued.sid)).then(r => r?.valid ?? null), null);
  const verified = await withTenant(application, scope.bOwner, client => verifySidCredential(client, issued.sid));
  assert.equal(verified.valid, true);
  assert.equal(verified.credentialId, accepted.credentialId);
});

test('a transfer request from a member is refused and an expired one cannot be accepted', async () => {
  const issued = await issue(scope.aOwner, activation());
  const att = await attest(scope.aOwner, issued);
  await assert.rejects(
    withTenant(application, scope.aMember, client => requestSidTransfer(client, scope.aMember, { transferId: `tr_${randomUUID().slice(0, 12)}`, sid: issued.sid, toOrganizationId: orgs.b, expiresAt: Date.now() + 3600_000 })),
    error => error instanceof SidAuthorityError && error.code === 'transfer_forbidden',
  );
  const transferId = `tr_${randomUUID().slice(0, 12)}`;
  await withTenant(application, scope.aOwner, client => requestSidTransfer(client, scope.aOwner, { transferId, sid: issued.sid, toOrganizationId: orgs.b, expiresAt: Date.now() + 3600_000 }));
  await admin.query("UPDATE uap.sid_transfers SET expires_at = $2 WHERE transfer_id = $1", [transferId, Date.now() - 1]);
  const expiredAt = Date.now();
  await assert.rejects(
    withTenant(application, scope.bOwner, client => acceptSidTransfer(client, scope.bOwner, {
      transferId, credentialId: `cred_${randomUUID().slice(0, 12)}`, keyId: keyIds.b, issuedAt: expiredAt,
      signature: signCredential(keys.b.privateKey, credentialPayload({ sid: issued.sid, organizationId: orgs.b, identityHash: issued.identityHash, keyId: keyIds.b, issuedAt: expiredAt, supersedes: att.credentialId })),
    })),
    error => error instanceof SidAuthorityError && error.code === 'transfer_expired',
  );
});

test('a transfer request with a past expiry is refused at request time', async () => {
  const issued = await issue(scope.aOwner, activation());
  await assert.rejects(
    withTenant(application, scope.aOwner, client => requestSidTransfer(client, scope.aOwner, { transferId: `tr_${randomUUID().slice(0, 12)}`, sid: issued.sid, toOrganizationId: orgs.b, expiresAt: Date.now() - 1 })),
    error => error instanceof SidAuthorityError && error.code === 'transfer_expired',
  );
});

test('a revoked SID cannot be transferred', async () => {
  const issued = await issue(scope.aOwner, activation());
  await attest(scope.aOwner, issued);
  await withTenant(application, scope.aOwner, client => revokeSidIdentity(client, scope.aOwner, { sid: issued.sid, reason: 'compromised' }));
  await assert.rejects(
    withTenant(application, scope.aOwner, client => requestSidTransfer(client, scope.aOwner, { transferId: `tr_${randomUUID().slice(0, 12)}`, sid: issued.sid, toOrganizationId: orgs.b, expiresAt: Date.now() + 3600_000 })),
    error => error instanceof SidAuthorityError && error.code === 'sid_not_active',
  );
});
