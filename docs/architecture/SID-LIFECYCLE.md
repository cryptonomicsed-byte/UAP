# SID lifecycle — pause, resume, archive (V6-04-08)

A SID is the persistent principal of one activated specialist instance. Pause is
not deletion: the identity, its identity hash, its role-template binding, its
Hermes model selections and its installation records all stay. The status is what
a consumer must consult before admitting new work.

## State machine (database-owned)

```
             pause (member+)                resume (member+)
  active ───────────────────► paused ───────────────────────► active
    │                            │
    │ archive (owner/admin)      │ archive (owner/admin)
    ▼                            ▼
  archived ──────────────────────────────────────────────► (terminal)
```

* `active` — normal service.
* `paused` — no new work is admitted; nothing is destroyed and no installation is
  touched, so an in-flight job on that installation can still settle.
* `archived` — end of service. Live installations are set to `removed` in the same
  transaction, so a restarted runtime cannot rejoin under this SID. There is no
  resume path: a replacement is a new SID whose `lineage_parent_id` points at the
  archived one (see `identity-schema.ts`).
* `revoked` — set by the revocation authority (D-14), not by lifecycle. Lifecycle
  refuses to move a revoked SID: pause, resume and archive all fail with
  `sid_revoked`. Revocation stays the last word.

Refusals are explicit and stable: `sid_not_active` (double pause), `sid_not_paused`
(resume of an active SID), `sid_archived` (any transition from archived),
`sid_already_archived` (double archive), `sid_revoked`, `sid_missing` (not in this
tenant — a foreign SID is never confirmed to exist), `tenant_forbidden` (session
organization does not match the argument, or role too low), `sid_input_invalid`.

Roles: `pause`/`resume` need `owner`, `admin` or `member`; `archive` needs `owner`
or `admin`, because it is the destructive one.

## Active jobs

Pause does not cancel or drain in-flight work: the transition only flips the SID
status, and the installation row is untouched, so a worker that already holds a
lease can settle it. Archive does retire installations, so it must be used when the
operator intends to stop the agent — an in-flight job on a removed installation is
reconciled by the worker's own lease rules (track F), not by the lifecycle call.

## Admission contract

The gate is `uap.sid_identities.status = 'active'`. The read path
(`readSidInstance` in `server/src/identity/sid.ts`) returns the status inside the
caller's tenant, and the lifecycle read (`readSidLifecycle`) returns the ordered
transitions. **A consumer that admits work — queue claim, worker spawn, tool
dispatch — must check that status; this item does not claim to have wired a
specific consumer yet.** Until it is wired, pause is a state change with audit
evidence, not an enforced quota.

## Audit log

`uap.sid_lifecycle_events` — one row per transition: `seq` (per SID), `event_type`,
`from_status`, `to_status`, `reason` (3–500 chars), `actor_id` (from
`uap.actor_id`), `occurred_at` (epoch ms). Row-level security scopes reads to the
tenant. The table is append-only by trigger: `UPDATE`, `DELETE` and `TRUNCATE`
raise `42501 sid_lifecycle_events_append_only` for every role, including the
database owner; the application login holds `SELECT` only.

## Schema

Migration 11 (`sid_lifecycle_pause_resume_archive`, `lifecycle-schema.ts`) adds the
log, its append-only triggers, an `agent_installations` UPDATE policy (archive must
retire installations; nothing else may update them) and four functions:

| function | role | returns |
| --- | --- | --- |
| `uap.pause_sid_instance(org, sid, reason)` | owner/admin/member | `(sid, status, affected_installations)` |
| `uap.resume_sid_instance(org, sid)` | owner/admin/member | `(sid, status, affected_installations)` |
| `uap.archive_sid_instance(org, sid, reason)` | owner/admin | `(sid, status, affected_installations)` |
| `uap.apply_sid_lifecycle(...)` | internal (`SECURITY DEFINER`) | state machine, not granted to the app role |

`grantApplicationRole` grants `EXECUTE` on the three public functions and `SELECT`
on the log, and refuses a login that can write the log or execute the internal
helper.

## Tests

`tests/postgres/sid-lifecycle.test.mjs` (10 tests, real PostgreSQL 16 through the
disposable harness) covers: pause keeps the hash and appends one event; resume
restores without re-issuing; double pause / resume-of-active refused; archive
retires installations; archived never resumes and is not archived twice; revoked
SIDs are never moved; reason validation; cross-tenant pause refused as
`sid_missing` and record untouched; member may pause/resume but not archive; the
log is append-only for the owner and read-only for the app login; another tenant
reads no events.

## Not claimed

* No checklist box is checked; the checker flips `verified`.
* Work admission is not yet wired to the status in the queue, worker or tool
  dispatch (track F / G) — see the admission contract above.
* No UI control surface (`agents.pause` API route) in this item.
* Revocation, issuer trust and transfer are D-14 (`SID-AUTHORITY.md`).
