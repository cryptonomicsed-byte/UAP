# Source trust: separated statuses, signed promotion, scheduled re-audit

Covers checklist items **V6-02-08** (separated source trust statuses and independent
reviewer signature for promotion) and **V6-02-09** (scheduled re-audit / revocation alerts).
Implementation: `server/src/sources/trust.ts`, `server/src/sources/reaudit.ts`.

The registry (B-20) stores facts about a source. This layer decides whether those facts are
enough to claim the source is trusted, and when that claim expires. It owns no storage: it
takes a record and returns a decision, so the registry writer persists a promotion that was
already validated.

## Why a ladder instead of a boolean

A single `trusted` flag cannot answer "trusted for what". Each rung is a separate claim with
its own evidence, and the evidence is cumulative — skipping rungs is allowed only by
supplying everything the skipped rungs would have required.

| Rung | Claim | Additional evidence | Reviewer capability |
| --- | --- | --- | --- |
| `USER_SUPPLIED_UNVERIFIED` | a URL was supplied | — | — |
| `PUBLIC_LOCATED` | the repository is publicly readable | access observed `ok` | `source-reviewer` |
| `PINNED_SHA` | the content is immutable | 40-hex commit + SHA-256 manifest | `source-reviewer` |
| `LICENSE_APPROVED` | use is permitted | SPDX id or a known commercial-use verdict | `source-reviewer` |
| `STATIC_AUDITED` | no unresolved critical finding | audit report digest, 0 criticals | `security-auditor` |
| `SANDBOX_EVALUATED` | it behaves in isolation | sandbox run id, outcome `pass` | `security-auditor` |
| `PUBLISHED` | it may be offered to tenants | tenant-policy digest, policy passed | `release-manager` |

Only `LICENSE_APPROVED` and above are installable (`auditBlockers` in B-20's ingest module
uses the same set), so a quarantine that demotes below that line removes the source from
installs without deleting its history.

## What the reviewer signs

The signature is Ed25519 over one canonical JSON statement with a fixed key order:

```json
{"v":1,"kind":"uap.source.trust.promotion","source_id":"src_…","canonical_url":"https://github.com/…",
 "pinned_commit":"…","manifest_digest":"…","from":"USER_SUPPLIED_UNVERIFIED","to":"STATIC_AUDITED",
 "reviewer_id":"rev-alice","reviewer_key":"<sha256 of SPKI DER, first 32 hex>","signed_at":1760000000000,
 "evidence_digest":"<sha256 of the key-sorted evidence>"}
```

Because the statement carries the source id, URL, pin, manifest digest, `from`, `to` and the
evidence digest, a signature cannot be replayed onto another source, another rung, a
different pin, or a different audit report. The reviewer's key fingerprint is inside the
statement, so a rotated or forged key is reported as `reviewer_key_mismatch` before any
crypto verification, instead of looking like a bad signature.

Freshness: 15 minutes by default (`maxSignatureAgeMs`), 2 minutes of future skew tolerated.
A promotion is a decision made now, not a credential stored for later.

## Independence

The reviewer who signs a rung must not be:

- the identity that **submitted** the source (`submittedBy`),
- the identity that **ingested** it (`ingestedBy`),
- the person who **performed the audit** being approved (`evidence.audit.auditorId`).

Capability separation compounds it: `STATIC_AUDITED` needs `security-auditor`, `PUBLISHED`
needs `release-manager`, so no single role can move a source from URL to catalogue alone.

## Revocation

`revokeSource` is not a signature. It is an operator or advisory action that:

1. demotes the source to `USER_SUPPLIED_UNVERIFIED`,
2. clears the reviewer signature (the database CHECK accepts an unverified row without one),
3. appends a revocation record with reason, detail, advisory id, time and actor.

After a revocation, `evaluatePromotion` refuses every rung with `revoked_requires_reaudit`
until `lastAuditedAt` is newer than `revokedAt`. Re-auditing is the only way back, which is
what stops a revoked source from being re-promoted by replaying an old signature.

## Scheduled re-audit

Cadence is per rung and compressed by risk class (`REAUDIT_POLICY`):

| Rung | Days | | Risk | Multiplier |
| --- | --- | --- | --- | --- |
| `PUBLISHED` | 30 | | `critical` | 0.25 |
| `USER_SUPPLIED_UNVERIFIED`, `PUBLIC_LOCATED` | 30 | | `high` | 0.5 |
| `PINNED_SHA`, `STATIC_AUDITED`, `SANDBOX_EVALUATED` | 90 | | `medium`, `unclassified` | 1 |
| `LICENSE_APPROVED` | 180 | | `low` | 1.5 |

`dueReaudits` returns three reasons, each actionable in a different way:

- `cadence` — the audit is older than the rung allows;
- `never_audited` — the source carries a trust rung with no audit stamp at all;
- `revoked_pending_reaudit` — revoked and not re-audited since, so it must not disappear
  from the queue just because it was demoted.

## Advisories

`matchAdvisories` joins advisories against the pinned dependency set and origin:

| Advisory | Match | Severity | Action |
| --- | --- | --- | --- |
| `vulnerable-package` | dependency name + `affectedRange` (npm subset: `^`, `~`, `>=`, `<`, exact, `\|\|`) | by advisory | `critical`→revoke, `high`→quarantine, else note |
| `compromised-origin` | origin owner | `critical` | `revoke_now` |
| `archived-upstream` | owner (+ repo) | `info` | `note` |
| `license-changed` | owner | `moderate` | `note` |

Alert ids are `alert_` + the first 16 hex of `sha256(source_id|advisory_id)`, so a scheduler
can deduplicate notifications across runs and a repeated feed entry does not double-alert.
`applyAdvisory` is idempotent per advisory id: `revoke_now` revokes once, `quarantine`
demotes to `PUBLIC_LOCATED` once and keeps the old approval record (it is now insufficient,
not erased), `note` returns the source untouched.

## HTTP surface

Both endpoints are computations over posted records — nothing is persisted, because the
registry owns writes:

- `POST /api/sources/trust/evaluate` — body `{source, target, reviewers, signature, evidence, now}`,
  returns `{decision}` with `allowed`, `blockers[]` (typed codes), `statementDigest`, and the
  promoted `record` when allowed.
- `POST /api/sources/reaudit/plan` — body `{sources, advisories, now}`, returns
  `{plan: {due[], notDue}, alerts[]}`.

Both are behind the normal `/api` owner session and reject anonymous callers with 401.

## Not in this layer

- **Persistence and the ingest pipeline** — B-20 (`server/src/sources/ingest.ts`,
  `server/src/storage/postgres/source-registry.ts`).
- **Reviewer key distribution** — the caller resolves `ReviewerKey[]`; how those keys are
  enrolled and rotated is a registry/identity concern.
- **Notification delivery** — the plan and alert objects are deterministic; deciding who is
  paged is the scheduler's job.
