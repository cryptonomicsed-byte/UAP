// SID credential signatures (V6-04-05). The credential binds a SID to the
// identity hash it was issued with and to the issuer key that attested it; a
// provider switch, reinstall or ownership transfer must never forge a new
// attestation for an old identity hash.
//
// Pure crypto: no database, no network. The bytes signed here are the same
// bytes the Postgres record function stores, so verification can be repeated
// from the stored row alone.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import {
  credentialPayload,
  publicKeyBase64,
  signCredential,
  verifyCredential,
} from '../server/src/identity/issuer.ts';

const identityHash = 'a'.repeat(64);
const fields = {
  sid: 'sid_example_immutable',
  organizationId: 'org_example',
  identityHash,
  keyId: 'key_2026_01',
  issuedAt: 1764000000000,
  supersedes: null,
};

const keyPair = () => generateKeyPairSync('ed25519');
const rawPublic = pair => pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

test('the payload is stable, newline-delimited and names each bound field', () => {
  const payload = credentialPayload(fields);
  assert.equal(payload, [
    'uap-sid-credential/1',
    'sid_example_immutable',
    'org_example',
    identityHash,
    'key_2026_01',
    '1764000000000',
    '-',
  ].join('\n'));
  assert.equal(credentialPayload({ ...fields, supersedes: 'cred_0' }).split('\n').at(-1), 'cred_0');
  assert.throws(() => credentialPayload({ ...fields, identityHash: 'not-a-hash' }), /identityHash/);
  assert.throws(() => credentialPayload({ ...fields, sid: 'SID_upper' }), /sid/);
});

test('a signature verifies only for the exact payload and key', () => {
  const pair = keyPair();
  const payload = credentialPayload(fields);
  const signature = signCredential(pair.privateKey, payload);

  assert.equal(verifyCredential(rawPublic(pair), payload, signature), true);
  assert.equal(verifyCredential(rawPublic(keyPair()), payload, signature), false);
  assert.equal(verifyCredential(rawPublic(pair), `${payload}x`, signature), false);
  assert.equal(verifyCredential(rawPublic(pair), payload, Buffer.alloc(64).toString('base64')), false);
});

test('a malformed key or signature is refused instead of throwing', () => {
  const pair = keyPair();
  const payload = credentialPayload(fields);
  const signature = signCredential(pair.privateKey, payload);
  assert.equal(verifyCredential('not-base64', payload, signature), false);
  assert.equal(verifyCredential(rawPublic(pair), payload, 'AAAA'), false);
  assert.throws(() => signCredential(generateKeyPairSync('ed25519').publicKey, payload), /private/i);
});

test('exported public keys are raw 32-byte Ed25519 keys', () => {
  const raw = Buffer.from(publicKeyBase64(keyPair().publicKey), 'base64');
  assert.equal(raw.length, 32);
});

test('the signed payload can be rebuilt from the stored row fields', () => {
  const pair = keyPair();
  const payload = credentialPayload(fields);
  const signature = signCredential(pair.privateKey, payload);
  // Rebuild from a row shaped like the credential table.
  const row = {
    sid: fields.sid, organization_id: fields.organizationId, identity_hash: fields.identityHash,
    key_id: fields.keyId, issued_at: fields.issuedAt, supersedes_credential_id: null,
  };
  const rebuilt = credentialPayload({
    sid: row.sid, organizationId: row.organization_id, identityHash: row.identity_hash,
    keyId: row.key_id, issuedAt: row.issued_at, supersedes: row.supersedes_credential_id,
  });
  assert.equal(verifyCredential(rawPublic(pair), rebuilt, signature), true);
});
