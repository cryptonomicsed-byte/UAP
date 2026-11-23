# Worker binding contract (V6-06-02)

Status: implemented by `AgentosWorker.TaskWorker` and `AgentosWorker.Lease` (M2-09),
inside the M2-08 scaffold `elixir/agentos_worker`. This document is the
normative description; the tests in `elixir/agentos_worker/test/agentos_worker/task_worker_test.exs`
are the executable version of it.

## Rule

A task worker exists for exactly one task, under exactly one SID, pinned to an
immutable role+skill digest, holding one signed lease. If any of those four facts
cannot be proven at startup, the worker must **refuse to start** with a specific
reason. A worker that starts on unverified inputs is an unauthenticated executor.

## Inputs (one map, no defaults guessed)

```elixir
%{
  task:  %{task_id, tenant, sid, role_digest, skill_digest},
  lease: %{v: "uap-lease/1", lease_id, task_id, tenant, sid, role_digest,
           grant_id, epoch, issued_at_ms, expires_at_ms,
           revocation: %{list, version}, nonce},
  signature: %{sig_hex, issuer_pub_hex},   # Ed25519 over "uap-lease/1\n" <> canonical
  registry: name | nil,                     # optional per-SID registry
  clock: (-> now_ms) | nil                  # injectable clock for tests
}
```

## Startup checks, in order (first failure stops the worker)

| # | Reason code | Condition |
|---|---|---|
| 1 | `:invalid_task` | task map missing a key or a value is not a non-empty binary |
| 2 | `:invalid_sid` | SID outside `[a-z0-9][a-z0-9._:-]{2,127}` (same grammar as `Sid::parse`) |
| 3 | `:invalid_digest` | role_digest or skill_digest not 64 lowercase hex |
| 4 | `:lease_schema` | lease keys differ from the contract, `v` wrong, wrong type, non-int counter |
| 5 | `:lease_signature` | canonical bytes do not reproduce / Ed25519 verification fails |
| 6 | `:sid_mismatch` | `lease.sid != task.sid` |
| 7 | `:tenant_mismatch` | `lease.tenant != task.tenant` |
| 8 | `:task_mismatch` | `lease.task_id != task.task_id` |
| 9 | `:role_digest_mismatch` | `lease.role_digest != task.role_digest` |
| 10 | `:lease_epoch` | `epoch < 1` or window inverted / empty |
| 11 | `:lease_not_yet_valid` | `now < issued_at_ms` |
| 12 | `:lease_expired` | `now >= expires_at_ms` |

Canonical encoding and signature domain are **not** re-invented here: they are the
`uap-lease/1` contract already proven by 5 golden fixtures across Rust, Python, Go
and Elixir (`crates/agentos-policy/fixtures/`, `docs/architecture/POLICY-KERNEL.md`).
The in-app verifier must reproduce `canonical.sha256` for every fixture; a test
asserts that, so the worker cannot drift from the kernel.

## Immutability

After start, the binding snapshot (`binding/1`) is read-only:

* `rebind/2` returns `{:error, :immutable_binding}` and changes nothing.
* Role and skill digests are captured once, at `init/1`; no cast exists that
  rewrites them.
* The lease expiry arms a timer; at expiry the worker stops with
  `:lease_expired` rather than continuing on an expired credential.

## What this item does not claim

* Revocation enforcement at call boundaries (the kernel's job; the worker only
  records `revocation.list`/`version` so a later dispatch check can be tied to it).
* Per-SID concurrency and backpressure (V6-06-04).
* Hermes session binding (V6-06-05).
* Durable queue claim/fencing (V6-06-03).
