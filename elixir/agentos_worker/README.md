# agentos_worker — ephemeral task execution (OTP)

Architecture freeze authority **#2**: ephemeral task execution and its lifecycle
belong to this app. Rust `agentos-policy` authorizes effects; PostgreSQL owns queue
truth and receipts; Hermes reasons. Nothing here may duplicate those authorities.

## What exists (M2-08..M2-12)

| Piece | Purpose |
|---|---|
| `AgentosWorker.Application` | Root supervisor: `Registry` (unique task keys) + `TaskSupervisor` (`:one_for_one` DynamicSupervisor) |
| `AgentosWorker.Registry` | `via/1` + `whereis/1` naming helpers; reclaims keys automatically when a task dies |
| `AgentosWorker.status/0` | Live status read from the supervisors; `tasks: nil` when the task supervisor is down (an idle worker and a dead worker never look alike) |
| `AgentosWorker.TaskWorker` | Per-task GenServer: SID + role/skill digest + signed lease, immutable binding, lease-expiry stop, effect state, graceful cancel, fenced settlement (M2-09, M2-11) |
| `AgentosWorker.Lifecycle` | Reconciliation policy: settle what is proven, reconcile what is uncertain, retry only when the retry-safety contract allows it (M2-11) |
| `AgentosWorker.Queue` / `.Queue.Postgres` | The one durable queue boundary: claim, heartbeat, settle, outbox claim/mark/release through granted transition functions, `{generation, token}` fencing |
| `AgentosWorker.Queue.OutboxRelay` | At-least-once delivery of committed events with backoff and dead-lettering |
| `AgentosWorker.Staging.Concurrency` | 1/10/100 concurrency staging drill; returns violations and writes the evidence artifact |

## What does **not** exist yet

Checkpointing before/after non-idempotent effects (V6-06-06), spawn timeouts and
tombstone reaping (V6-06-08), secret wipe on exit (V6-06-09). Restart, graceful
cancel and `UNCERTAIN` reconciliation are implemented (M2-11); the contract is
`docs/architecture/WORKER-LIFECYCLE.md`.

Do not add task semantics to the scaffold: extend it in the item that owns the
semantics, with failing tests first.

## Commands

```sh
mix test                 # ExUnit suite (no database needed)
mix check                # format check + warnings-as-errors compile + tests
mix test.postgres        # queue contract against a disposable real PostgreSQL
mix test.staging         # 1/10/100 concurrency drill (disposable database)
mix format
```

`mix test.staging` (or `npm run test:staging` from the repo root) runs
`AgentosWorker.Staging.Concurrency` at 1, 10 and 100 concurrent worker processes
and writes `tests/out/elixir/staging-concurrency.json`. To run it against a real
staging database instead of a disposable one, set `TEST_DATABASE_URL` (admin
login that seeds fixtures) and `TEST_WORKER_DATABASE_URL` (worker login holding
only the granted transition functions). See
`docs/architecture/STAGING-CONCURRENCY.md` for what the drill does and does not
prove.

CI: the `elixir-worker` job in `.github/workflows/foundation.yml` runs `mix check`
and the `elixir-staging` job runs the concurrency drill against a PostgreSQL
service, on OTP 27 / Elixir 1.17 (local toolchain here is older; the app targets
`~> 1.14`).
