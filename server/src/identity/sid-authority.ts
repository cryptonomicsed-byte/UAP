/**
 * SID authority service (V6-04-05): issuer trust, signed credentials,
 * revocation and two-party ownership transfer.
 *
 * The signature is checked here, against the public key the tenant registered,
 * *before* the row is stored — PostgreSQL cannot verify Ed25519, so the database
 * alone would accept a forged signature. Conversely this module does not decide
 * who may act: every function below calls a SECURITY DEFINER transition that
 * re-derives the actor, tenant and role from the session settings.
 */
import type { PoolClient } from 'pg';
import { credentialPayload, verifyCredential } from './issuer.js';

export type SidFailure =
  | 'issuer_forbidden' | 'issuer_exists' | 'issuer_missing' | 'issuer_untrusted' | 'issuer_revoked'
  | 'issuer_status_invalid' | 'issuer_input_invalid'
  | 'credential_exists' | 'credential_input_invalid' | 'credential_supersedes_mismatch' | 'credential_supersedes_required'
  | 'signature_invalid'
  | 'sid_missing' | 'sid_not_active' | 'sid_revoked' | 'sid_foreign_tenant' | 'tenant_forbidden'
  | 'already_revoked' | 'revoke_forbidden' | 'revocation_input_invalid'
  | 'transfer_forbidden' | 'transfer_exists' | 'transfer_missing' | 'transfer_not_pending'
  | 'transfer_expired' | 'transfer_org_missing' | 'transfer_input_invalid'
  | 'role_digest_mismatch' | 'input_invalid' | 'unknown';

export class SidAuthorityError extends Error {
  readonly code: SidFailure;

  constructor(code: SidFailure, message: string) {
    super(message);
    this.name = 'SidAuthorityError';
    this.code = code;
  }
}

interface Scope { organizationId: string }

const FAILURES: readonly SidFailure[] = [
  'issuer_forbidden', 'issuer_exists', 'issuer_missing', 'issuer_untrusted', 'issuer_revoked',
  'issuer_status_invalid', 'issuer_input_invalid',
  'credential_exists', 'credential_input_invalid', 'credential_supersedes_mismatch', 'credential_supersedes_required',
  'signature_invalid',
  'sid_missing', 'sid_not_active', 'sid_revoked', 'sid_foreign_tenant', 'tenant_forbidden',
  'already_revoked', 'revoke_forbidden', 'revocation_input_invalid',
  'transfer_forbidden', 'transfer_exists', 'transfer_missing', 'transfer_not_pending',
  'transfer_expired', 'transfer_org_missing', 'transfer_input_invalid',
  'role_digest_mismatch', 'input_invalid',
];

function translate(error: unknown): never {
  if (error instanceof SidAuthorityError) throw error;
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? '');
  const named = FAILURES.find(failure => message.includes(failure));
  if (named) throw new SidAuthorityError(named, message);
  if (code === '42501') throw new SidAuthorityError('tenant_forbidden', 'the request is not permitted for this tenant');
  if (code === 'P0003') throw new SidAuthorityError('input_invalid', 'input is invalid');
  throw error;
}

function requireText(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new SidAuthorityError('input_invalid', `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

export interface IssuerKey {
  issuerId: string;
  keyId: string;
  status: 'trusted' | 'revoked';
}

async function loadIssuer(client: PoolClient, scope: Scope, keyId: string): Promise<IssuerKey & { publicKey: string } | null> {
  const result = await client.query<{ issuer_id: string; key_id: string; public_key: string; status: IssuerKey['status'] }>(
    'SELECT issuer_id, key_id, public_key, status FROM uap.sid_issuers WHERE organization_id=$1 AND key_id=$2',
    [scope.organizationId, keyId]);
  const row = result.rows[0];
  return row ? { issuerId: row.issuer_id, keyId: row.key_id, publicKey: row.public_key, status: row.status } : null;
}

export async function registerSidIssuer(
  client: PoolClient, scope: Scope,
  input: { issuerId: string; keyId: string; publicKey: string },
): Promise<string> {
  requireText(input.issuerId, 'issuerId');
  requireText(input.keyId, 'keyId');
  if (typeof input.publicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(input.publicKey)) {
    throw new SidAuthorityError('issuer_input_invalid', 'publicKey must be a base64 raw Ed25519 key');
  }
  try {
    const result = await client.query<{ register_sid_issuer: string }>(
      'SELECT uap.register_sid_issuer($1,$2,$3,$4)', [scope.organizationId, input.issuerId, input.keyId, input.publicKey]);
    return result.rows[0].register_sid_issuer;
  } catch (error) { translate(error); }
}

export async function setSidIssuerStatus(
  client: PoolClient, scope: Scope, input: { keyId: string; status: 'revoked' },
): Promise<string> {
  requireText(input.keyId, 'keyId');
  if (input.status !== 'revoked') throw new SidAuthorityError('issuer_status_invalid', 'issuer keys can only be revoked');
  try {
    const result = await client.query<{ set_sid_issuer_status: string }>(
      'SELECT uap.set_sid_issuer_status($1,$2,$3)', [scope.organizationId, input.keyId, input.status]);
    return result.rows[0].set_sid_issuer_status;
  } catch (error) { translate(error); }
}

export async function recordSidCredential(
  client: PoolClient, scope: Scope,
  input: { credentialId: string; sid: string; keyId: string; issuedAt: number; signature: string; supersedes?: string | null },
): Promise<{ credentialId: string; identityHash: string }> {
  requireText(input.credentialId, 'credentialId');
  requireText(input.sid, 'sid');
  requireText(input.keyId, 'keyId');
  if (!Number.isInteger(input.issuedAt) || input.issuedAt < 0) {
    throw new SidAuthorityError('input_invalid', 'issuedAt must be epoch milliseconds');
  }
  if (typeof input.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature)) {
    throw new SidAuthorityError('input_invalid', 'signature must be base64 of a 64-byte Ed25519 signature');
  }

  const issuer = await loadIssuer(client, scope, input.keyId);
  if (!issuer) throw new SidAuthorityError('issuer_untrusted', 'this organization does not trust that issuer key');
  if (issuer.status !== 'trusted') throw new SidAuthorityError('issuer_revoked', 'the issuer key is revoked');
  const identity = await client.query<{ identity_hash: string; status: string; current_credential_id: string | null }>(
    'SELECT identity_hash, status, current_credential_id FROM uap.sid_identities WHERE sid=$1', [input.sid]);
  const row = identity.rows[0];
  if (!row) throw new SidAuthorityError('sid_missing', 'no such SID in this tenant');
  if (row.status !== 'active') throw new SidAuthorityError('sid_not_active', `a ${row.status} SID cannot be re-signed`);

  const payload = credentialPayload({
    sid: input.sid, organizationId: scope.organizationId, identityHash: row.identity_hash,
    keyId: input.keyId, issuedAt: input.issuedAt, supersedes: input.supersedes ?? null,
  });
  if (!verifyCredential(issuer.publicKey, payload, input.signature)) {
    throw new SidAuthorityError('signature_invalid', 'the signature does not cover this SID, tenant, identity hash and key');
  }

  try {
    const result = await client.query<{ credential_id: string; identity_hash: string }>(
      'SELECT * FROM uap.record_sid_credential($1,$2,$3,$4,$5,$6,$7)',
      [scope.organizationId, input.sid, input.credentialId, input.keyId, input.issuedAt, input.signature, input.supersedes ?? null]);
    const recorded = result.rows[0];
    if (!recorded) throw new SidAuthorityError('unknown', 'credential recording returned no row');
    return { credentialId: recorded.credential_id, identityHash: recorded.identity_hash };
  } catch (error) { translate(error); }
}

export interface VerifiedCredential {
  sid: string;
  credentialId: string;
  keyId: string;
  identityHash: string;
  /** Cryptographic validity against the stored bytes. */
  signatureValid: boolean;
  /** Whether the credential may be trusted right now (signature + live key + live SID). */
  valid: boolean;
  reason?: SidFailure | 'unsigned';
}

/** Rebuilds the signed payload from the stored row and verifies it. */
export async function verifySidCredential(client: PoolClient, sid: string): Promise<VerifiedCredential | null> {
  const identity = await client.query<{
    sid: string; status: string; identity_hash: string; current_credential_id: string | null;
  }>('SELECT sid, status, identity_hash, current_credential_id FROM uap.sid_identities WHERE sid=$1', [sid]);
  const row = identity.rows[0];
  if (!row) return null;
  if (!row.current_credential_id) {
    return { sid: row.sid, credentialId: '', keyId: '', identityHash: row.identity_hash, signatureValid: false, valid: false, reason: 'unsigned' };
  }
  const credential = await client.query<{
    credential_id: string; key_id: string; issuer_organization_id: string; identity_hash: string; issued_at: number;
    supersedes_credential_id: string | null; signature: string; public_key: string; issuer_status: string;
  }>(
    `SELECT credential.credential_id, credential.key_id, credential.issuer_organization_id, credential.identity_hash,
       credential.issued_at, credential.supersedes_credential_id, credential.signature, issuer.public_key,
       issuer.status AS issuer_status
     FROM uap.sid_credentials AS credential
     JOIN uap.sid_issuers AS issuer
       ON issuer.organization_id = credential.issuer_organization_id AND issuer.key_id = credential.key_id
     WHERE credential.credential_id=$1`, [row.current_credential_id]);
  const current = credential.rows[0];
  if (!current) {
    return { sid: row.sid, credentialId: row.current_credential_id, keyId: '', identityHash: row.identity_hash, signatureValid: false, valid: false, reason: 'issuer_untrusted' };
  }
  const payload = credentialPayload({
    sid: row.sid, organizationId: current.issuer_organization_id,
    identityHash: current.identity_hash, keyId: current.key_id, issuedAt: Number(current.issued_at),
    supersedes: current.supersedes_credential_id,
  });
  const signatureValid = verifyCredential(current.public_key, payload, current.signature);
  const base = { sid: row.sid, credentialId: current.credential_id, keyId: current.key_id, identityHash: current.identity_hash, signatureValid };
  if (!signatureValid) return { ...base, valid: false, reason: 'signature_invalid' };
  if (row.status === 'revoked') return { ...base, valid: false, reason: 'sid_revoked' };
  if (current.issuer_status !== 'trusted') return { ...base, valid: false, reason: 'issuer_revoked' };
  if (current.identity_hash !== row.identity_hash) return { ...base, valid: false, reason: 'signature_invalid' };
  return { ...base, valid: true };
}

export async function revokeSidIdentity(
  client: PoolClient, scope: Scope, input: { sid: string; reason: string },
): Promise<{ status: string; revokedAt: number; epoch: number }> {
  requireText(input.sid, 'sid');
  requireText(input.reason, 'reason', 500);
  try {
    const result = await client.query<{ status: string; revoked_at: number; epoch: number }>(
      'SELECT * FROM uap.revoke_sid_identity($1,$2,$3)', [scope.organizationId, input.sid, input.reason]);
    const row = result.rows[0];
    if (!row) throw new SidAuthorityError('unknown', 'revocation returned no row');
    return { status: row.status, revokedAt: Number(row.revoked_at), epoch: row.epoch };
  } catch (error) { translate(error); }
}

export async function requestSidTransfer(
  client: PoolClient, scope: Scope,
  input: { transferId: string; sid: string; toOrganizationId: string; expiresAt: number },
): Promise<{ transferId: string; status: string }> {
  requireText(input.transferId, 'transferId');
  requireText(input.sid, 'sid');
  requireText(input.toOrganizationId, 'toOrganizationId');
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new SidAuthorityError('input_invalid', 'expiresAt must be epoch milliseconds');
  }
  try {
    const result = await client.query<{ transfer_id: string; status: string }>(
      'SELECT * FROM uap.request_sid_transfer($1,$2,$3,$4,$5)',
      [input.transferId, scope.organizationId, input.sid, input.toOrganizationId, input.expiresAt]);
    const row = result.rows[0];
    if (!row) throw new SidAuthorityError('unknown', 'transfer request returned no row');
    return { transferId: row.transfer_id, status: row.status };
  } catch (error) { translate(error); }
}

export async function acceptSidTransfer(
  client: PoolClient, scope: Scope,
  input: { transferId: string; credentialId: string; keyId: string; issuedAt: number; signature: string },
): Promise<{ sid: string; credentialId: string }> {
  requireText(input.transferId, 'transferId');
  requireText(input.credentialId, 'credentialId');
  requireText(input.keyId, 'keyId');
  if (!Number.isInteger(input.issuedAt) || input.issuedAt < 0) {
    throw new SidAuthorityError('input_invalid', 'issuedAt must be epoch milliseconds');
  }
  if (typeof input.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(input.signature)) {
    throw new SidAuthorityError('input_invalid', 'signature must be base64 of a 64-byte Ed25519 signature');
  }

  const issuer = await loadIssuer(client, scope, input.keyId);
  if (!issuer) throw new SidAuthorityError('issuer_untrusted', 'the receiving organization does not trust that issuer key');
  if (issuer.status !== 'trusted') throw new SidAuthorityError('issuer_revoked', 'the issuer key is revoked');

  // The SID still belongs to the sender, so its identity hash is read from the
  // pending transfer the receiving tenant is allowed to see.
  const transfer = await client.query<{
    sid: string; identity_hash: string; supersedes_credential_id: string | null; status: string;
  }>(
    `SELECT sid, identity_hash, supersedes_credential_id, status FROM uap.sid_transfers
     WHERE transfer_id=$1 AND to_organization_id=$2`, [input.transferId, scope.organizationId]);
  const pending = transfer.rows[0];
  if (!pending) throw new SidAuthorityError('transfer_missing', 'no such transfer for this tenant');
  if (pending.status !== 'pending') throw new SidAuthorityError('transfer_not_pending', `transfer is ${pending.status}`);

  const payload = credentialPayload({
    sid: pending.sid,
    organizationId: scope.organizationId,
    identityHash: pending.identity_hash,
    keyId: input.keyId,
    issuedAt: input.issuedAt,
    supersedes: pending.supersedes_credential_id,
  });
  if (!verifyCredential(issuer.publicKey, payload, input.signature)) {
    throw new SidAuthorityError('signature_invalid', 'the acceptance signature does not cover this SID, tenant, identity hash and key');
  }

  try {
    const result = await client.query<{ sid: string; credential_id: string }>(
      'SELECT * FROM uap.accept_sid_transfer($1,$2,$3,$4,$5,$6)',
      [input.transferId, scope.organizationId, input.credentialId, input.keyId, input.issuedAt, input.signature]);
    const row = result.rows[0];
    if (!row) throw new SidAuthorityError('unknown', 'transfer acceptance returned no row');
    return { sid: row.sid, credentialId: row.credential_id };
  } catch (error) { translate(error); }
}
