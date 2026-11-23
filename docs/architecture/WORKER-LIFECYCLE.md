# Worker lifecycle: restart, cancel, crash recovery and UNCERTAIN reconciliation (V6-06-07)

Status: implemented by `AgentosWorker.Lifecycle` and `AgentosWorker.TaskWorker`
(M2-11). The tests are the executable form of this document:
`test/agentos_worker/lifecycle_test.exs`, `test/agentos_worker/task_worker_test.exs`
and the queue contract tests in `test/agentos_worker/queue/postgres_test.exs`.

## Rule

**No work is retried because a process died.** A retry needs a proven effect
state *and* a retry-safety contract that allows a repeat. Everything else is
reconciled by a human or a later attempt that the database hands out explicitly.

Three authorities, and only three:

| Question | Authority |
|---|---|
| May this job be handed out again after a lease expired? | `uap.claim_task_job` recovery loop (PostgreSQL) |
| What does a live worker ask for when it stops? | `AgentosWorker.Lifecycle` (this app) |
| Did the settlement actually happen? | `uap.settle_task_job` (PostgreSQL, fenced) |

## Effect states (`TaskWorker.report_effect/2`)

A worker records what it *knows* about the side effect, not what it hopes:

| Report | Meaning |
|---|---|
| `:none` | Nothing was dispatched (default) |
| `:uncertain` | A non-provable action may have landed (timeout after send, lost reply) |
| `:applied` | The effect is proven (receipt, provider acknowledgement, idempotency key read-back) |

Transitions only move forward: `:none → :applied | :uncertain`,
`:uncertain → :applied` when proof arrives. **Proof is never downgraded** —
`report_effect(:uncertain)` after `:applied` returns `{:error, :effect_already_applied}`,
and a second `:none` report returns `{:error, :effect_already_reported}`.

## Settlement plan (`Lifecycle.settlement/1`)

Input is one attempt report: `retry_safety` (`idempotent` | `reconcile_only`),
`effect`, `cancel_requested`, `number` (this attempt), `max` (attempt ceiling),
`retry_delay_ms` (base backoff). Output is data: `outcome`, `retry_in_ms`,
`error`, `reason`. First matching row wins:

| Condition | Outcome | Retry |
|---|---|---|
| effect `:applied`, cancellation requested | `incomplete` (`cancelled_after_effect`) | none |
| effect `:applied` | `succeeded` | none |
| effect `:uncertain`, `reconcile_only` | `incomplete` (`uncertain_effect`) | **none** |
| effect `:uncertain`, attempts exhausted | `failed` (`uncertain_effect`) | none |
| effect `:uncertain`, `idempotent` | `failed` (`uncertain_effect_retry`) | backoff |
| cancellation requested, effect not applied | `cancelled` | none |
| `reconcile_only` | `incomplete` (`reconcile_only`) | **none** |
| attempts exhausted | `failed` (`attempts_exhausted`) | none |
| otherwise | `failed` | backoff |

Backoff is `retry_delay_ms * 2^(number-1)`, capped at one hour. An incomplete
or malformed report returns `{:error, :invalid_report}`; defaults are never
guessed for a security-relevant field.

The database validates the plan again. `uap.settle_task_job`:

* refuses `cancelled` when `cancel_requested_at IS NULL` (the operator's
  cancellation must exist, not just the worker's belief);
* refuses `succeeded` while an approval is pending, allowed, expired or revoked;
* turns `failed` + retry into `incomplete` for `reconcile_only` work, cancelling
  work or a consumed approval — so even a wrong plan cannot cause a blind retry;
* turns `failed` + retry beyond the attempt ceiling into `dead_letter`.

## Graceful cancel

1. An operator calls `uap.request_task_job_cancellation`. A queued job becomes
   `cancelled` immediately; a running job becomes `cancelling` and the worker's
   `cancel_requested_at` is recorded.
2. The runner calls `TaskWorker.cancel/1`. The worker moves to `:cancelling`,
   stops accepting new effects, and is idempotent (`{:ok, :cancelling}` twice).
3. The runner stops its work and calls `TaskWorker.finish/3`. If the effect never
   landed the plan is `cancelled`; if it landed before the acknowledgement the
   plan is `incomplete` with `cancelled_after_effect` — a cancellation is never
   used to hide completed work.

`TaskWorker.cancel/1` alone is not a cancellation: settling `cancelled` without
step 1 is refused by the database (`Queue.TransitionError`).

## Restart and crash recovery

* `TaskWorker` children are `:temporary` in the `DynamicSupervisor`. A crash is
  not silently restarted — a test kills a worker and asserts it does not come
  back (`TaskWorker` is gone from the registry and the task count returns to its
  previous value).
* A crashed process took its lease token with it, so it cannot settle anything:
  `Lifecycle.crash_recovery/2` only says how long the queue must wait
  (`{:wait, remaining_ms}` or `:reclaimable`). The recovery loop in
  `uap.claim_task_job` then decides:
  * `incomplete` for `cancelling` work, `reconcile_only` work, or a consumed approval;
  * `queued` for idempotent work with attempts left;
  * `dead_letter` at the attempt ceiling.
* A restarted worker gets a **new** generation and token from `claim`; the old
  lease is stale (`StaleLeaseError`) and cannot heartbeat or settle.

## What this item does not claim

* Checkpointing before/after non-idempotent effects (V6-06-06).
* Spawn timeouts, stuck-child reaping and tombstones (V6-06-08).
* Secret wipe on exit (V6-06-09).
* Per-SID concurrency and backpressure (V6-06-04).
* SID, approved memory and receipts surviving worker termination (V6-06-10).
