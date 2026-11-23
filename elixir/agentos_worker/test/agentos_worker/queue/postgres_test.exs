defmodule AgentosWorker.QueuePostgresTest do
  @moduledoc """
  Real-PostgreSQL contract for the single durable queue (V6-06-03).

  These tests are the negative-first proof for claiming, lease fencing and the
  transactional outbox: a stale generation or a foreign token is refused without
  mutating the job, a relay that lost its delivery lease cannot publish, failed
  delivery retries and then dead-letters, and the relay publishes committed
  events exactly as the database recorded them.

  Run with `mix test.postgres` (provisions a disposable database and applies the
  authoritative `uap` migrations); plain `mix test` skips them.
  """
  use ExUnit.Case, async: false

  alias AgentosWorker.Queue
  alias AgentosWorker.Queue.OutboxRelay
  alias AgentosWorker.Queue.Postgres

  @moduletag :postgres

  setup_all do
    # `conn` is the isolated worker login: it holds EXECUTE on the granted
    # transition functions and no table privileges. `admin` seeds fixtures,
    # because uap.users has FORCE ROW LEVEL SECURITY and no INSERT policy.
    {:ok, conn} =
      Postgres.start_link(
        url: System.fetch_env!("TEST_WORKER_DATABASE_URL"),
        name: :queue_pg_test,
        pool_size: 1
      )

    {:ok, admin} =
      Postgres.start_link(
        url: System.fetch_env!("TEST_DATABASE_URL"),
        name: :queue_pg_admin,
        pool_size: 1
      )

    suffix = Base.encode16(:crypto.strong_rand_bytes(6), case: :lower)
    org = "org_#{suffix}"
    owner = "owner_#{suffix}"
    space = "space_#{suffix}"
    now = System.system_time(:millisecond)

    Postgrex.query!(
      admin,
      "INSERT INTO uap.users(id,email,name,created_at) VALUES ($1,$2,$1,$3)",
      [owner, "#{owner}@example.test", now]
    )

    Postgrex.query!(
      admin,
      "INSERT INTO uap.organizations(id,slug,name,created_at) VALUES ($1,$1,$1,$2)",
      [org, now]
    )

    Postgrex.query!(
      admin,
      "INSERT INTO uap.memberships(organization_id,user_id,role,state,created_at) VALUES ($1,$2,'owner','active',$3)",
      [org, owner, now]
    )

    Postgrex.query!(
      admin,
      "INSERT INTO uap.workspaces(id,organization_id,name,created_at) VALUES ($1,$2,$1,$3)",
      [space, org, now]
    )

    on_exit(fn -> :ok end)
    %{conn: conn, admin: admin, org: org, owner: owner, space: space}
  end

  # Each test owns the outbox: an outbox claim is exclusive, so rows left behind
  # by an earlier test would be leased to this test's relay id and look
  # unclaimable. The relay under test is the only consumer in the harness.
  setup %{admin: admin} do
    Postgrex.query!(admin, "TRUNCATE uap.job_outbox", [])
    :ok
  end

  defp map_row(%Postgrex.Result{columns: columns, rows: [row]}),
    do: Map.new(Enum.zip(columns, row))

  defp enqueue(ctx, name, opts \\ []) do
    unique = System.unique_integer([:positive])
    agent = "agent_#{name}_#{unique}"
    job = "job_#{name}_#{unique}"
    task = "task_#{name}_#{unique}"
    kind = Keyword.get(opts, :kind, "queue.test.#{name}.#{unique}")
    retry_safety = Keyword.get(opts, :retry_safety, "idempotent")
    max_attempts = Keyword.get(opts, :max_attempts, 3)
    now = System.system_time(:millisecond)

    Postgrex.query!(
      ctx.admin,
      "INSERT INTO uap.agents(id,organization_id,workspace_id,owner_user_id,name,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$1,$5,$5)",
      [agent, ctx.org, ctx.space, ctx.owner, now]
    )

    Postgrex.query!(
      ctx.admin,
      "SELECT set_config('uap.actor_id',$1,false), set_config('uap.organization_id',$2,false)",
      [ctx.owner, ctx.org]
    )

    digest = Base.encode16(:crypto.hash(:sha256, "#{kind}/#{unique}"), case: :lower)

    Postgrex.query!(
      ctx.admin,
      "SELECT * FROM uap.enqueue_task_job($1,$2,$3,$4,$5,$6,'', $7, $8::jsonb, $9, $10,
        $13, $14, 100, $11, $12, NULL, 'v1', 'decision-1', 'unmetered_local', NULL)",
      [
        ctx.org,
        task,
        job,
        ctx.space,
        agent,
        name,
        kind,
        %{"input" => name},
        "key_#{unique}",
        digest,
        now,
        "trace_#{unique}",
        retry_safety,
        max_attempts
      ]
    )

    %{org: ctx.org, job: job, task: task, agent: agent, kind: kind}
  end

  defp job_state(ctx, job) do
    map_row(
      Postgrex.query!(
        ctx.admin,
        "SELECT state, lease_generation, lease_owner FROM uap.task_jobs WHERE organization_id=$1 AND id=$2",
        [ctx.org, job]
      )
    )
  end

  test "claim returns a fenced lease whose stored hash matches the token, and a second claim never repeats it",
       ctx do
    queued = enqueue(ctx, "claim")
    worker = "worker_#{System.unique_integer([:positive])}"

    assert {:ok, %{lease: lease, job: job}} =
             Postgres.claim(ctx.conn, worker, [queued.kind], 60_000)

    assert lease.job_id == queued.job
    assert lease.generation == 1
    assert job["lease_owner"] == worker
    assert job["lease_token_hash"] == Queue.token_hash(lease.token)
    assert Queue.token_hash(lease.token) != lease.token

    assert {:ok, nil} = Postgres.claim(ctx.conn, worker, [queued.kind], 60_000),
           "a running job was handed out twice"
  end

  test "a stale generation or a foreign token cannot heartbeat, and the refusal changes nothing",
       ctx do
    queued = enqueue(ctx, "fence")
    worker = "worker_#{System.unique_integer([:positive])}"
    assert {:ok, %{lease: lease}} = Postgres.claim(ctx.conn, worker, [queued.kind], 60_000)
    before = job_state(ctx, queued.job)

    forged_generation = %{lease | generation: lease.generation + 1}

    assert {:error, %Queue.StaleLeaseError{job_id: job_id}} =
             Postgres.heartbeat(ctx.conn, forged_generation, 60_000)

    assert job_id == queued.job

    forged_token = %{lease | token: Queue.new_token()}
    assert {:error, %Queue.StaleLeaseError{}} = Postgres.heartbeat(ctx.conn, forged_token, 60_000)

    after_refusals = job_state(ctx, queued.job)
    assert after_refusals["state"] == before["state"]
    assert after_refusals["lease_owner"] == before["lease_owner"]
    assert after_refusals["lease_generation"] == before["lease_generation"]

    assert {:ok, _job} = Postgres.heartbeat(ctx.conn, lease, 60_000),
           "the legitimate lease stopped working after forged attempts"
  end

  test "settling with a stale lease is refused and leaves the job running", ctx do
    queued = enqueue(ctx, "settle")
    worker = "worker_#{System.unique_integer([:positive])}"
    assert {:ok, %{lease: lease}} = Postgres.claim(ctx.conn, worker, [queued.kind], 60_000)

    stale = %{lease | generation: lease.generation + 1}
    assert {:error, %Queue.StaleLeaseError{}} = Postgres.settle(ctx.conn, stale, "succeeded")
    assert job_state(ctx, queued.job)["state"] == "running"

    assert {:ok, settled} = Postgres.settle(ctx.conn, lease, "succeeded")
    assert settled["state"] == "succeeded"
    assert settled["lease_owner"] == nil
  end

  test "a crashed reconcile-only lease is reconciled to incomplete and never re-offered", ctx do
    queued = enqueue(ctx, "reconcile", retry_safety: "reconcile_only")
    worker = "worker_#{System.unique_integer([:positive])}"

    assert {:ok, %{lease: lease}} = Postgres.claim(ctx.conn, worker, [queued.kind], 1_000)

    # The worker "crashes": no heartbeat, no settlement. The next claim runs the
    # recovery loop, which owns the decision — the app does not get to retry.
    Process.sleep(1_200)

    assert {:ok, nil} = Postgres.claim(ctx.conn, worker, [queued.kind], 60_000)
    assert job_state(ctx, queued.job)["state"] == "incomplete"

    assert {:error, %Queue.StaleLeaseError{}} = Postgres.settle(ctx.conn, lease, "succeeded"),
           "a dead lease settled work it no longer owned"
  end

  test "a crashed idempotent lease with attempts left is re-queued exactly once", ctx do
    queued = enqueue(ctx, "requeue")
    worker = "worker_#{System.unique_integer([:positive])}"

    assert {:ok, %{lease: first}} = Postgres.claim(ctx.conn, worker, [queued.kind], 1_000)
    Process.sleep(1_200)

    assert {:ok, %{lease: second}} = Postgres.claim(ctx.conn, worker, [queued.kind], 60_000)
    assert second.generation == first.generation + 1
    assert job_state(ctx, queued.job)["state"] == "running"

    assert {:error, %Queue.StaleLeaseError{}} = Postgres.heartbeat(ctx.conn, first, 60_000)
  end

  test "cancellation is refused without an operator request, and settles once it exists", ctx do
    queued = enqueue(ctx, "cancel")
    worker = "worker_#{System.unique_integer([:positive])}"

    assert {:ok, %{lease: lease}} = Postgres.claim(ctx.conn, worker, [queued.kind], 60_000)

    assert {:error, %Queue.TransitionError{}} = Postgres.settle(ctx.conn, lease, "cancelled"),
           "an unrequested cancellation was accepted"

    assert job_state(ctx, queued.job)["state"] == "running"

    Postgrex.query!(ctx.admin, "SELECT * FROM uap.request_task_job_cancellation($1,$2)", [
      ctx.org,
      queued.job
    ])

    assert job_state(ctx, queued.job)["state"] == "cancelling"

    assert {:ok, settled} = Postgres.settle(ctx.conn, lease, "cancelled")
    assert settled["state"] == "cancelled"
    assert settled["cancel_requested_at"] != nil
  end

  test "an unproven effect can be settled incomplete, and incomplete work is never re-offered",
       ctx do
    queued = enqueue(ctx, "uncertain")
    worker = "worker_#{System.unique_integer([:positive])}"

    assert {:ok, %{lease: lease}} = Postgres.claim(ctx.conn, worker, [queued.kind], 60_000)

    assert {:ok, settled} =
             Postgres.settle(ctx.conn, lease, "incomplete", error: %{"code" => "uncertain_effect"})

    assert settled["state"] == "incomplete"

    other = "worker_#{System.unique_integer([:positive])}"
    assert {:ok, nil} = Postgres.claim(ctx.conn, other, [queued.kind], 60_000)
  end

  test "committed events are claimable, a relay that lost its lease cannot publish them, and publishing is one-way",
       ctx do
    queued = enqueue(ctx, "outbox")
    relay = "relay_#{System.unique_integer([:positive])}"
    other = "relay_#{System.unique_integer([:positive])}"

    assert {:ok, events} = Postgres.claim_outbox(ctx.conn, relay, limit: 500, lock_ms: 30_000)
    event = Enum.find(events, &(&1["job_id"] == queued.job))
    assert event, "the committed enqueue event was not claimable"
    assert event["event_type"] == "job.queued"

    assert event["payload"] == %{
             "kind" => queued.kind,
             "retrySafety" => "idempotent",
             "executionCostClass" => "unmetered_local"
           }

    assert {:ok, false} = Postgres.mark_published(ctx.conn, other, event["event_id"])

    assert {:ok, "stale"} =
             Postgres.release(ctx.conn, other, event["event_id"],
               retry_in_ms: 0,
               error: "not mine",
               max_attempts: 3
             )

    assert {:ok, true} = Postgres.mark_published(ctx.conn, relay, event["event_id"])
    assert {:ok, false} = Postgres.mark_published(ctx.conn, relay, event["event_id"])

    # Publishing clears the delivery lease, so a later release from the same
    # relay is stale: it holds nothing any more and cannot resurrect the row.
    assert {:ok, "stale"} =
             Postgres.release(ctx.conn, relay, event["event_id"],
               retry_in_ms: 0,
               error: "late",
               max_attempts: 3
             )

    assert {:ok, again} = Postgres.claim_outbox(ctx.conn, relay, limit: 500)
    refute Enum.any?(again, &(&1["event_id"] == event["event_id"]))
  end

  test "failed delivery retries with backoff and dead-letters at the ceiling", ctx do
    queued = enqueue(ctx, "dead")
    relay = "relay_#{System.unique_integer([:positive])}"

    {:ok, events} = Postgres.claim_outbox(ctx.conn, relay, limit: 500)
    event = Enum.find(events, &(&1["job_id"] == queued.job))
    assert event

    # The first failure settles the lease acquired above; each later attempt
    # re-claims the row after the previous release handed it back.
    {:ok, "retry"} =
      Postgres.release(ctx.conn, relay, event["event_id"],
        retry_in_ms: 0,
        error: "publisher failure 1",
        max_attempts: 3
      )

    states =
      for attempt <- 2..3 do
        {:ok, claimed} = Postgres.claim_outbox(ctx.conn, relay, limit: 500)
        current = Enum.find(claimed, &(&1["event_id"] == event["event_id"]))
        assert current, "row was not claimable on attempt #{attempt}"

        {:ok, state} =
          Postgres.release(ctx.conn, relay, current["event_id"],
            retry_in_ms: 0,
            error: "publisher failure #{attempt}",
            max_attempts: 3
          )

        state
      end

    assert states == ["retry", "dead"]

    {:ok, claimed} = Postgres.claim_outbox(ctx.conn, relay, limit: 500)

    refute Enum.any?(claimed, &(&1["event_id"] == event["event_id"])),
           "a dead-lettered row was claimable"

    {:ok, stats} = Postgres.outbox_state(ctx.conn)
    assert is_integer(stats["dead_lettered"]) and stats["dead_lettered"] >= 1
  end

  test "the relay publishes committed events through its publisher and marks them published",
       ctx do
    queued = enqueue(ctx, "relay")
    test_pid = self()
    relay_id = "relay_#{System.unique_integer([:positive])}"

    publisher = fn event ->
      send(test_pid, {:published, event["event_id"]})
      :ok
    end

    start_supervised!(
      {OutboxRelay,
       conn: ctx.conn,
       relay_id: relay_id,
       publisher: publisher,
       batch_size: 100,
       lock_ms: 5_000,
       max_attempts: 3,
       poll_interval_ms: 20,
       base_backoff_ms: 5}
    )

    assert_receive {:published, event_id}, 1_000
    assert is_binary(event_id)

    {:ok, events} = Postgres.claim_outbox(ctx.conn, "probe_#{relay_id}", limit: 500)

    refute Enum.any?(events, &(&1["job_id"] == queued.job)),
           "the published event was still deliverable"

    {:ok, status} = OutboxRelay.status(OutboxRelay)
    assert status["published"] >= 1
    assert is_nil(status["last_error"])
  end

  test "a failing publisher is retried and then dead-lettered without crashing the relay", ctx do
    queued = enqueue(ctx, "relay_fail")
    relay_id = "relay_#{System.unique_integer([:positive])}"
    test_pid = self()

    publisher = fn event ->
      send(test_pid, {:attempt, event["event_id"]})
      {:error, "upstream unavailable"}
    end

    start_supervised!(
      {OutboxRelay,
       conn: ctx.conn,
       relay_id: relay_id,
       publisher: publisher,
       batch_size: 100,
       lock_ms: 5_000,
       max_attempts: 1,
       poll_interval_ms: 20,
       base_backoff_ms: 1}
    )

    assert_receive {:attempt, _event_id}, 1_000

    wait_until(
      fn ->
        {:ok, status} = OutboxRelay.status(OutboxRelay)
        status["dead"] >= 1
      end,
      2_000
    )

    {:ok, status} = OutboxRelay.status(OutboxRelay)
    assert status["dead"] >= 1
    assert status["last_error"] =~ "upstream unavailable"
    assert Process.alive?(Process.whereis(OutboxRelay))

    assert job_state(ctx, queued.job)["state"] == "queued",
           "outbox failure must not touch job state"
  end

  defp wait_until(fun, timeout_ms) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_wait(fun, deadline)
  end

  defp do_wait(fun, deadline) do
    if fun.() do
      :ok
    else
      if System.monotonic_time(:millisecond) >= deadline,
        do: flunk("condition not met before deadline")

      Process.sleep(20)
      do_wait(fun, deadline)
    end
  end
end
