# Staging concurrency drill (M2-12 / V6-06-03)

`AgentosWorker.Staging.Concurrency` drives the durable queue at **1, 10 and 100
concurrent worker processes** and returns facts, not a verdict: every check
produces either a number that must equal the workload size or a violation
string. The ExUnit test fails if the violation list is non-empty; CI uploads the
report as evidence.

## What one level does

For `N` in `{1, 10, 100}`, in a fresh tenant of its own:

1. **Seed** — one owner, organization and workspace, plus `N` agents, tasks and
   `uap.enqueue_task_job` rows (`retry_safety = idempotent`, cost class
   `unmetered_local`, one distinct agent per job so the queue's per-agent
   exclusion is not what serialises the drill). Seeding runs on the **admin**
   login only; `uap.users` has `FORCE ROW LEVEL SECURITY` and no insert policy.
2. **Claim** — `N` Elixir processes each call
   `uap.claim_task_job` through the **worker** login (EXECUTE on the granted
   transition functions, no table privileges) until the queue reports empty,
   then one final drain on the test process. The drain matters: a worker can see
   "empty" while another claim still holds the last row's lock.
3. **Settle** — every returned lease is settled `succeeded`, concurrently.
4. **Repeat-settle** — every lease is settled a second time. Each attempt must
   be refused with `AgentosWorker.Queue.StaleLeaseError`; an accepted repeat is
   a violation, not a retry.
5. **Ledger truth** — read back on the admin connection, scoped to the drill's
   own job ids:
   * terminal state map is exactly `%{"succeeded" => N}`;
   * `agent_runs` has exactly `N` succeeded runs (one effect per job);
   * `job_events` has exactly `N` `job.queued`, `N` `job.claimed`, `N`
     `job.succeeded`, and no duplicated `(job_id, event_type)` pair;
   * `job_outbox` has exactly `3N` mirrored rows (trigger-written, one per
     committed event);
   * every job is still on `lease_generation = 1`, `attempt_count = 1`
     (nothing was reclaimed or silently retried).

The report also records `elapsed_ms` per level and the database pool size used
(20 connections for the 100-process level). The elapsed numbers are evidence
that the workload completed, **not** a capacity benchmark.

## Running it

```sh
# disposable local database (root shell with local PostgreSQL)
npm run test:staging

# a staging database you already migrated and granted
TEST_DATABASE_URL=postgres://admin:... \
TEST_WORKER_DATABASE_URL=postgres://worker:... \
  npm run test:staging

# from the app directory
mix test.staging
```

Disposable mode creates one database, an admin login (`BYPASSRLS`) and a worker
login, applies the authoritative `uap` migrations, runs
`db:postgres grant-job-worker`, runs the drill, and drops everything on exit.
Provided mode does not create or drop anything.

The report is written to `tests/out/elixir/staging-concurrency.json` (git
ignored; CI uploads it as `elixir-staging-evidence`).

## What this drill does not prove

* **Crash recovery** — no worker is killed mid-lease. Lease expiry, restart and
  `UNCERTAIN` reconciliation belong to M2-11.
* **Outbox delivery** — the relay is not run; the assertion is that exactly one
  outbox row exists per committed event. At-least-once delivery, backoff and
  dead-lettering are covered by the queue contract tests (`mix test.postgres`).
* **Network partitions / multi-node staging** — driver processes and PostgreSQL
  share one host. Multi-node behaviour needs a real staging deployment with the
  same URLs.
* **Throughput/CPU** — the number of database connections is bounded (20), which
  is deliberate: 100 worker processes contending for a realistic pool is the
  shape being stressed, not 100 raw connections.
