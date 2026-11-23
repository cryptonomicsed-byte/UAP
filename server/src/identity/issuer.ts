/**
 * SID credential signatures (V6-04-05).
 *
 * A credential attests one claim with an Ed25519 issuer key: "this SID, in this
 * organization, has this identity hash, under this key, at this time". The
 * payload is newline-delimited ASCII with no optional whitespace, so the exact
 * bytes can be rebuilt from the stored row and re-verified years later without
 * trusting the row's JSON formatting.
 *
 * The database owns authority (which keys an organization trusts, whether a
 * credential may be recorded, whether a SID may transfer); this module owns the
 * bytes and the signature check. Neither alone is sufficient: a stored
 * signature is only meaningful when the verifier recomputes the payload and
 * checks it against a trusted key.
 */
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

export interface CredentialFields {
  sid: string;
  organizationId: string;
  identityHash: string;
  keyId: string;
  issuedAt: number;
  supersedes?: string | null;
}

const SID_RE = /^sid_[a-z0-9][a-z0-9_-]{0,62}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

/** Deterministic bytes covered by the signature. `-` marks "no predecessor". */
export function credentialPayload(fields: CredentialFields): string {
  if (!SID_RE.test(fields.sid ?? '')) throw new Error('sid must match sid_<slug>');
  if (typeof fields.organizationId !== 'string' || !fields.organizationId) throw new Error('organizationId is required');
  if (!DIGEST_RE.test(fields.identityHash ?? '')) throw new Error('identityHash must be a 64-hex sha256');
  if (typeof fields.keyId !== 'string' || !fields.keyId) throw new Error('keyId is required');
  if (!Number.isInteger(fields.issuedAt) || fields.issuedAt < 0) throw new Error('issuedAt must be epoch milliseconds');
  return [
    'uap-sid-credential/1',
    fields.sid,
    fields.organizationId,
    fields.identityHash,
    fields.keyId,
    String(fields.issuedAt),
    fields.supersedes ?? '-',
  ].join('\n');
}

/** Raw 32-byte Ed25519 public key exported from an SPKI key object. */
export function publicKeyBase64(key: KeyObject): string {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('expected an Ed25519 public key');
  const der = key.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

export function signCredential(privateKey: KeyObject, payload: string): string {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('signCredential requires an Ed25519 private key');
  }
  return sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

/** Verification never throws on bad input: an unverifiable credential is false. */
export function verifyCredential(publicKeyB64: string, payload: string, signatureB64: string): boolean {
  try {
    const raw = Buffer.from(publicKeyB64, 'base64');
    if (raw.length !== 32) return false;
    const signature = Buffer.from(signatureB64, 'base64');
    if (signature.length !== 64) return false;
    // wrap raw key in SPKI DER: 302a300506032b6570032100 || key
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return verify(null, Buffer.from(payload, 'utf8'), key, signature);
  } catch {
    return false;
  }
}
