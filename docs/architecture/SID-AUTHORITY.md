# SID authority: signature, issuer trust, revocation and transfer

Scope: V6-04-05. Code: `server/src/identity/issuer.ts` (bytes and signature),
`server/src/identity/sid-authority.ts` (service), migration 10
(`server/src/storage/postgres/sid-authority-schema.ts`).

## Division of authority

| Question | Answered by |
|---|---|
| Which Ed25519 keys does a tenant trust? | `uap.sid_issuers` (owner/admin registers, revocation is one-way) |
| May this credential be stored? | `uap.record_sid_credential` — key trusted, SID active in that tenant, credential replaces exactly the current one |
| Is the signature real? | Service, before the insert: payload rebuilt from the SID row and checked against the stored public key |
| May this SID move to another tenant? | `uap.request_sid_transfer` (owner of the source) + `uap.accept_sid_transfer` (owner of the target) |
| Is this SID revoked? | `uap.sid_revocations`; status becomes `revoked`, and no path re-signs or transfers it |

PostgreSQL cannot verify Ed25519, so a stored signature is never accepted on its
own: `verifySidCredential` recomputes the payload from the stored row and checks
the signature against the trusted key, and reports why a credential is not
trusted (`signature_invalid`, `issuer_revoked`, `sid_revoked`, `unsigned`).

## Signed payload

Newline-delimited, no optional whitespace, versioned:

```
uap-sid-credential/1
<sid>
<organization id at issuance>
<identity hash (sha256 of the stored identity document)>
<key id>
<issued at, epoch ms>
<supersedes credential id, or "-">
```

The same bytes are stored in `uap.sid_credentials` (`issued_at`,
`supersedes_credential_id`, `signature`), so verification is reproducible from
the database alone.

## Lifecycle

- **Attest** — `recordSidCredential`: the first credential has no predecessor; a
  re-sign must name the credential it replaces, so the chain stays linear. The
  identity hash is never supplied by the caller; the row's hash is used.
- **Issuer revocation** — `setSidIssuerStatus`: keys can only be revoked. A
  revoked key cannot attest; existing credentials remain as bytes but verify as
  `issuer_revoked`.
- **Recovery / key compromise** — re-sign the same identity hash with a
  still-trusted key, superseding the credential issued by the compromised key.
  The SID and its identity hash are unchanged (`FACT-E2E-015`). Losing every
  trusted key for a tenant is not recoverable through this protocol; that needs
  a separate owner identity ceremony and is not implemented here.
- **SID revocation** — `revokeSidIdentity`: one-way, records reason, actor and
  epoch. A revoked SID cannot be re-signed or transferred.
- **Transfer** — `requestSidTransfer` (owner of the source, live expiry) then
  `acceptSidTransfer` (owner of the target, signed by a key the target already
  trusts). In one transaction the installations, model selections and SID move
  to the target tenant, the role template version is copied only if the digest
  matches, and a new credential supersedes the old one. The old credential row
  and the identity hash stay in place; the previous tenant can no longer read the
  SID.

## Verification commands

```bash
TEST_POSTGRES_ADMIN_URL=... node scripts/test-postgres.mjs sid-authority.test.mjs sid-issuance.test.mjs
node --import tsx --test tests/sid-credential.test.mjs tests/sid-legacy.test.mjs
```
