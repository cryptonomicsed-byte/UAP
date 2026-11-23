# Policy kernel — contract specification (track E)

Status: **implemented, in-tree, tested**. Owner: Rust (`crates/agentos-policy`).
This document is the wire contract that the Elixir worker (track F), the Hermes
adapter (track G) and the portable verifiers (M1-07: Rust/Go/Python/Elixir) must
agree on. Code is authoritative; this file explains *why* the code looks like this.

Freeze reference: [`ARCHITECTURE-FREEZE.md`](./ARCHITECTURE-FREEZE.md) — Rust owns
permission, Elixir owns ephemeral execution, Hermes owns reasoning, Postgres owns
truth. Nothing in the platform may widen what this kernel allows.

## 1. Why a kernel and not middleware

An agent platform with tool access has one question that must have exactly one
answer: *may this action happen?* If that answer is assembled from a role prompt, a
UI checkbox and a provider's own safety filter, then no one can state it, test it,
or prove it after an incident.

The kernel is therefore:

* **Pure** — no clock, no I/O, no network, no model. `authorize(..., now_ms)` takes
  time as an argument, so a decision is reproducible from an audit record.
* **Total** — every refusal returns one of 32 stable reason codes. There is no
  "denied for unknown reasons" path.
* **Narrow** — it says *yes, once, for this exact action, until this timestamp*. It
  does not run tools and cannot be talked into anything.

## 2. Objects

| Object | Carries | Signed? |
|---|---|---|
| `ActionIntent` | intent id, tenant, SID, task, role digest, tool + tool schema digest, effect class, risk, exact target, argument digest, idempotency key, spend request, window, optional advisory | no (a request) |
| `Grant` | grant id, tenant, SID, effects, resource patterns, schema-pinned tools, risk ceiling, budget, window, epoch | yes, by an issuer |
| `TaskLease` | lease id, task, tenant, SID, role digest, grant id, epoch, window, revocation list + version, nonce | yes, by an issuer |
| `ApprovalRecord` | approval id, tenant, SID, intent id, **argument digest**, effect, accepted risk, window | yes, by a human approver |
| `ActionPermit` | permit id, lease id, task id, intent id, **intent digest**, effect, expiry | no (returned by the kernel) |

`ActionPermit` is one-use. It is not a bearer token: `verify_permit` re-computes the
intent digest and refuses a permit presented with different arguments.

## 3. Canonical encoding (must match in every language)

One document, one byte string. The rules:

1. UTF-8 JSON, no BOM, **no whitespace** outside strings.
2. Keys in the fixed order defined by the writer (not sorted at runtime). Field
   order is part of the protocol; adding a field is a version bump.
3. Values are strings, non-negative integers (decimal, no leading zeros, no
   exponent, no floats) or `null`.
4. Strings escape `"`, `\`, and control characters (short forms `\b \f \n \r \t`,
   otherwise `\u00XX`); everything else is verbatim. Every identifier is
   charset-restricted, so no escape ever fires for a lease or a grant.
5. Signatures cover `DOMAIN || "\n" || canonical_json`, where `DOMAIN` is
   `uap-lease/1`, `uap-grant/1`, `uap-intent/1` or `uap-approval/1`. Domain
   separation means a signature made for a lease cannot verify as a grant.

Lease canonical form (all fields required):

```json
{"v":"uap-lease/1","lease_id":"…","task_id":"…","tenant":"…","sid":"…","role_digest":"<64 hex>","grant_id":"…","epoch":1,"issued_at_ms":1700000000000,"expires_at_ms":1700000060000,"revocation":{"list":"…","version":12},"nonce":"<64 hex>"}
```

The signature is **not** inside the document (no strip-the-signature parsing).
Fixtures in `crates/agentos-policy/fixtures/` carry `fields.json` (the document
fields only, strict schema), `canonical.sha256` (SHA-256 of the canonical bytes
*rebuilt from those fields*), `sig.hex`, `issuer.pub.hex` and `expect.txt`
(`valid` / `invalid`). Committing the digest instead of the text avoids the
trailing-newline ambiguity that makes JSON fixtures rot. The full registry of
contracts, schemas, fixtures and per-language verifier status is
[`CONTRACTS.md`](./CONTRACTS.md).

## 4. Dispatch check order

Per call, in this order — the first failure is the one recorded and returned:

1. lease internally valid (window, epoch ≥ 1, ≤ 24 h)
2. issuer id trusted
3. lease signature verifies
4. lease window vs `now_ms` (half-open: valid at `issued`, invalid at `expires`)
5. revocation list version not newer than the lease's reference
6. task epoch not lower than the highest epoch seen for the task
7. intent internally valid
8. intent not expired
9–12. tenant, SID, task, role digest match the lease
13. grant exists; 14. not revoked; 15. not expired; 16. belongs to this tenant+SID
17. effect class conferred
18. tool in the grant
19. tool schema digest matches the pinned digest
20. risk within the grant ceiling
21. exact target matches a resource pattern
22. spend within budget ceilings (inclusive)
23. lease duration within the grant wall-time ceiling
24. replay: intent id unused, idempotency key unused (external effects)
25. approval present, unexpired, for this argument digest, effect, tenant, SID and
    risk (required for money / publish / production_change / security_testing /
    clinical_data, and for any Critical-risk action)
26. concurrency ceiling for `(tenant, SID)`

Only then: approval consumed, replay keys claimed, permit minted, reservation
recorded. Everything before that point is a read, so a denial leaves no state
behind and can be retried after the operator fixes the cause.

## 5. Human approval semantics

An approval is bound to the **argument digest**, not just the intent id. Approving
`$12.50` cannot authorise `$9,999.00`. Approvals are single-use via the intent's own
replay protection. Clearance is checked twice: at registration (an approver may not
sign above their clearance) and at dispatch (the accepted risk must cover the intent).

## 6. Advisory models

`ActionIntent.advisory` is recorded in the audit and **never read** by the decision.
Both directions are tested:

* advisory `allow` with 100 % confidence does not lift a denial;
* advisory `deny` with 99 % confidence does not block an allowed action.

Rationale: a compromised or babbling model must not be able to widen authority, and
must not be able to halt the platform either. `uncertain` is recorded as data for
threshold tuning, not as a gate.

## 7. Dead, expired and revoked workers (V6-05-10)

Three independent kill paths, all re-checked per call:

* **dead** — a newer lease for the same task has a higher epoch; the old lease fails
  `stale-epoch` for ever.
* **expired** — the half-open window closed; `lease-expired`.
* **revoked** — the revocation list advanced past the version inside the signed
  lease; `lease-revoked`. Because the version is signed, a worker cannot present a
  lease that pretends the list stood still.

The Vault path is not special: a secret read is an ordinary intent with a
`vault_secret:` target, so it dies with the lease.

## 8. Deliberately not in this crate (and where it lives)

* **Persistence and single-writer discipline** — the worker owns the queue and the
  transactional outbox (track F, `uap.task_jobs`). The kernel is in-memory by design
  so tests are exhaustive and decisions are replayable.
* **Key custody** — issuers/approvers are configured as public keys; private keys
  belong to a KMS, never to this repository.
* **Tool execution and sandboxing** — the executor is `Osovm`/track F; the kernel
  only hands it a permit.
* **Tenant/user/plan entitlement** — resolved before an intent is formed (track D/Q).

## 9. Test evidence

`cargo test --workspace` — see `AGENT-DECISIONS.md` for the run receipts. The
negative-path suite (`tests/dispatch.rs`, 30 tests) exercises every reason code that
can be produced by an action, plus the admission ledger and the audit trail.
