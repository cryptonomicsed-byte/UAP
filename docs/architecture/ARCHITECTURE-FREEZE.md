# Architecture freeze — ownership of authority (V6-01-06)

Status: **frozen 2026-11-23**. This document fixes who owns each authority in UAP and
what evidence proves the ownership is real. It is binding on all tracks: no role, skill
pack, gate, UI or model may acquire an authority listed here for a different component.

Frozen decisions (four, plus one queue and one ledger):

| # | Authority | Owner | Must never be |
|---|---|---|---|
| 1 | Permission to act (grants, leases, budgets, effect classes) | **Rust policy kernel** (`agentos-policy` crate) | A prompt, a persona, a TypeScript route guard, a gate label |
| 2 | Ephemeral task execution and its lifecycle | **Elixir `agentos-worker`** (OTP) | A forked Node process per task |
| 3 | Reasoning (planning, tool choice, language) | **Hermes Agent** | A second reasoning master inside UAP |
| 4 | Truth about work: queue state, receipts, evidence | **PostgreSQL** (`uap` schema) | Process memory, log lines, UI state |
| 5 | One queue | `uap.task_jobs` + `uap.job_worker_grants` (claim, fence, lease epoch) | Per-feature queues |
| 6 | One billing ledger | single append-only ledger table + ledger entries (track E/F) | Per-provider counters, per-tenant tallies |

## Why frozen

The v6 blueprint's failure mode is duplicated authority: two components that each believe
they may authorize an effect. Duplicated authority cannot be tested — whichever one is
lenient wins. Freezing one owner per authority makes every other component's job
*evidence submission* rather than *judgement*.

## What exists today (honest status, 2026-11-23)

| Authority | State | Evidence in tree | Gap (track) |
|---|---|---|---|
| Rust policy kernel | **absent** | — | build `agentos-policy`: ActionIntent, ResourceScope, Grant, Budget, Lease, dispatch validation, one-use permits (E) |
| Elixir worker | **absent** | — | build `agentos-worker` OTP app: registry, per-task GenServer, checkpointing, UNCERTAIN reconciliation (F) |
| Hermes reasoning | present | `server/src/engine.ts`, `server/src/providers.ts`, `server/src/agent/*` | policy interception at every tool call, typed action results, model swap without SID leakage (G) |
| Postgres truth | present | `uap.tasks`, `uap.task_jobs`, `uap.agent_runs`, `uap.approvals`, `uap.job_events`, `uap.job_worker_grants`, `uap.schema_migrations` | formal claim/fencing/outbox semantics, ledger table (E/F) |
| One queue | partial | `server/src/storage/postgres/jobs.ts`, `job-worker-grants.ts` | single writer discipline across TS and the future Elixir worker (F) |
| One ledger | **absent** | `uap.approvals` records approvals only, not money | ledger table + entries + reconciliation (E) |
| Instance identity (SID) | partial | `server/src/lib/ids.ts`, `uap.auth_sessions`, session grants | SID as per-instance identity with signature/revocation (D) |
| Rights & SBOM gate | **present since this freeze** | `scripts/audit-rights.mjs`, `docs/rights/`, CI job `rights` | reviewer-signed promotion, re-audit cron for sources (B/R) |

Nothing in this table is "done" in the checklist sense: boxes stay unchecked until an
independent grader signs the evidence (see CHECKLIST-v6.md tracking rules).

## Enforcement rules that follow

1. **Policy re-check at every privileged call.** A lease authorizes a task, not each
   effect inside it. Each effect needs a one-use permit issued by the policy kernel
   (V6-05-05). TypeScript may *ask*; it may not *allow*.
2. **Fail closed on policy unavailability.** If the kernel cannot be reached, privileged
   actions are denied, not queued-and-allowed (V6-18-09).
3. **One writer per queue row.** Claiming a job requires a fencing token that increments;
   a worker whose fence is stale must abandon and report `UNCERTAIN`, never retry the
   effect (V6-06-08).
4. **Non-idempotent effects get a checkpoint before and after.** Money, publish, prod,
   security and clinical effects are non-idempotent by definition (V6-05-06, V6-06-07).
5. **Human approval is data, not a UI dialog.** Approvals live in `uap.approvals` bound to
   the intent digest; a dialog that is not recorded is not an approval (V6-05-08).
6. **Model output is advice.** No model output can widen a grant, lower a risk class or
   skip a gate (V6-05-09).
7. **Rights are a build gate.** A dependency with a non-allowlisted license, or a bundled
   asset without a rights row, fails the build (`npm run audit:rights`), not a review.

## Change control

Changing an owner in this table requires a new dated section below stating what evidence
made the previous owner untenable. Silent ownership changes are the defect this document
exists to prevent.

### Revision history

* 2026-11-23 — initial freeze. Rust policy and Elixir worker recorded as **absent** on
  purpose so the freeze cannot be mistaken for a claim of parity.
