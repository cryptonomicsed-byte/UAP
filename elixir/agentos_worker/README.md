# agentos_worker — ephemeral task execution (OTP)

Architecture freeze authority **#2**: ephemeral task execution and its lifecycle
belong to this app. Rust `agentos-policy` authorizes effects; PostgreSQL owns queue
truth and receipts; Hermes reasons. Nothing here may duplicate those authorities.

## What exists (scaffold, M2-08)

| Piece | Purpose |
|---|---|
| `AgentosWorker.Application` | Root supervisor: `Registry` (unique task keys) + `TaskSupervisor` (`:one_for_one` DynamicSupervisor) |
| `AgentosWorker.Registry` | `via/1` + `whereis/1` naming helpers; reclaims keys automatically when a task dies |
| `AgentosWorker.status/0` | Live status read from the supervisors; `tasks: nil` when the task supervisor is down (an idle worker and a dead worker never look alike) |

## What does **not** exist yet

Per-task GenServer with SID + role digest + signed lease (M2-09), queue
claim/fencing/outbox (M2-10), restart/cancel/`UNCERTAIN` reconciliation (M2-11),
1/10/100 concurrency staging (M2-12), checkpointing, secret wipe on exit.

Do not add task semantics to the scaffold: extend it in the item that owns the
semantics, with failing tests first.

## Commands

```sh
mix test                 # ExUnit suite
mix check                # format check + warnings-as-errors compile + tests
mix format
```

CI: the `elixir` job in `.github/workflows/foundation.yml` runs `mix check` on
OTP 27 / Elixir 1.17 (local toolchain here is older; the app targets `~> 1.14`).
