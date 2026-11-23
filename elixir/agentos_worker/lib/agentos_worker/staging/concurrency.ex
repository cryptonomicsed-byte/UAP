defmodule AgentosWorker.Staging.Concurrency do
  @moduledoc """
  Staging concurrency drill for the durable queue (M2-12 / V6-06-03).

  Runs one workload at 1, 10 and 100 concurrent worker processes against a real
  PostgreSQL queue, then reports the facts a reviewer needs instead of an
  opinion: every enqueued job claimed exactly once, every claim settled exactly
  once, every repeat settlement refused, exactly one succeeded run and one
  claimed/succeeded event per job, and no job left claimable or non-terminal.

  This is a drill, not a scheduler. It seeds its own tenant fixtures through the
  admin connection (an admin login owns the database and bypasses RLS), drives
  every privileged transition through the worker login (which holds no table
  privileges), and never publishes the outbox — delivery is the relay's job and
  is covered by the queue contract tests. A violation list is returned, never a
  bare `:ok`, so an operator or CI can fail on it.
  """

  alias AgentosWorker.Queue
  alias AgentosWorker.Queue.Postgres

  @default_levels [1, 10, 100]
  @default_lease_ms 60_000
  @claim_timeout_ms 180_000

  @type level_report :: %{
          concurrency: pos_integer(),
          db_pool_size: pos_integer() | nil,
          enqueued: non_neg_integer(),
          claimed: non_neg_integer(),
          unique_claimed: non_neg_integer(),
          duplicate_claims: non_neg_integer(),
          settled_ok: non_neg_integer(),
          settle_failures: non_neg_integer(),
          duplicate_settle_refused: non_neg_integer(),
          duplicate_settle_accepted: non_neg_integer(),
          states: %{String.t() => non_neg_integer()},
          runs_succeeded: non_neg_integer(),
          events: %{String.t() => non_neg_integer()},
          duplicate_event_pairs: non_neg_integer(),
          outbox_rows: non_neg_integer(),
          bad_generations: non_neg_integer(),
          elapsed_ms: non_neg_integer(),
          violations: [String.t()]
        }

  @doc """
  Runs the drill. Required: `:worker` (queue connection as the worker login) and
  `:admin` (fixture connection). Optional: `:levels`, `:lease_ms`.

  Returns `{:ok, report}` with `report.violations` empty when the queue held, or
  `{:ok, report}` with the violations spelled out when it did not. A database
  failure that prevents the drill from running returns `{:error, exception}`.
  """
  @spec run(keyword()) :: {:ok, map()} | {:error, Exception.t()}
  def run(opts) do
    worker = Keyword.fetch!(opts, :worker)
    admin = Keyword.fetch!(opts, :admin)
    levels = Keyword.get(opts, :levels, @default_levels)
    lease_ms = Keyword.get(opts, :lease_ms, @default_lease_ms)
    pool_size = Keyword.get(opts, :pool_size)
    suite = "stg" <> Base.encode16(:crypto.strong_rand_bytes(4), case: :lower)

    try do
      tenant = seed_tenant(admin, suite)

      reports =
        Enum.map(levels, fn level ->
          drill(level, suite, tenant, worker, admin, lease_ms, pool_size)
        end)

      violations = Enum.flat_map(reports, & &1.violations)

      {:ok,
       %{
         suite: suite,
         generated_at_ms: System.system_time(:millisecond),
         levels: reports,
         violations: violations,
         ok: violations == []
       }}
    rescue
      error -> {:error, error}
    end
  end

  # ------------------------------------------------------------------- fixtures

  defp seed_tenant(admin, suite) do
    now = System.system_time(:millisecond)
    org = "#{suite}_org"
    owner = "#{suite}_owner"
    space = "#{suite}_space"

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

    # One admin connection (pool_size 1), so the tenant context survives the
    # fixture inserts on this session. enqueue_task_job refuses without it.
    Postgrex.query!(
      admin,
      "SELECT set_config('uap.actor_id',$1,false), set_config('uap.organization_id',$2,false)",
      [owner, org]
    )

    %{org: org, owner: owner, space: space, now: now}
  end

  defp enqueue_jobs(admin, tenant, suite, level) do
    kind = "#{suite}.drill.#{level}"
    now = System.system_time(:millisecond)

    jobs =
      for i <- 1..level do
        agent = "#{suite}_a#{level}_#{i}"
        task = "#{suite}_t#{level}_#{i}"
        job = "#{suite}_j#{level}_#{i}"
        key = "#{suite}_k#{level}_#{i}"

        Postgrex.query!(
          admin,
          "INSERT INTO uap.agents(id,organization_id,workspace_id,owner_user_id,name,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$1,$5,$5)",
          [agent, tenant.org, tenant.space, tenant.owner, now]
        )

        Postgrex.query!(
          admin,
          "SELECT * FROM uap.enqueue_task_job($1,$2,$3,$4,$5,$6,'',$7,$8::jsonb,$9,$10,
            'idempotent',3,100,$11,$12,NULL,'v1','decision-1','unmetered_local',NULL)",
          [
            tenant.org,
            task,
            job,
            tenant.space,
            agent,
            "drill #{level}/#{i}",
            kind,
            %{"input" => i},
            key,
            :crypto.hash(:sha256, key) |> Base.encode16(case: :lower),
            now,
            "trace_#{key}"
          ]
        )

        job
      end

    {kind, jobs}
  end

  # ---------------------------------------------------------------------- drill

  defp drill(level, suite, tenant, worker, admin, lease_ms, pool_size) do
    started = System.monotonic_time(:millisecond)
    {kind, jobs} = enqueue_jobs(admin, tenant, suite, level)

    claims = claim_phase(worker, level, suite, kind, lease_ms)
    leases = Enum.map(claims, fn {:ok, leases} -> leases end) |> List.flatten()
    claim_errors = for {:error, reason} <- claims, do: inspect(reason)

    job_ids = Enum.map(leases, & &1.job_id)
    unique_claimed = Enum.uniq(job_ids) |> length()
    duplicate_claims = length(job_ids) - unique_claimed
    missing = jobs -- job_ids

    settle = settle_phase(worker, leases, level)
    duplicate = duplicate_settle_phase(worker, leases)
    truth = ledger_truth(admin, tenant.org, jobs)

    elapsed_ms = System.monotonic_time(:millisecond) - started

    violations =
      []
      |> check(level != length(jobs), "enqueued #{length(jobs)} jobs for concurrency #{level}")
      |> check(claim_errors != [], "claim errors: #{Enum.join(Enum.take(claim_errors, 3), "; ")}")
      |> check(length(leases) != level, "claimed #{length(leases)} leases for #{level} jobs")
      |> check(duplicate_claims != 0, "#{duplicate_claims} duplicate claim(s)")
      |> check(missing != [], "#{length(missing)} job(s) never claimed")
      |> check(
        settle.failures != 0,
        "settle failures: #{Enum.join(Enum.take(settle.errors, 3), "; ")}"
      )
      |> check(
        duplicate.accepted != 0,
        "#{duplicate.accepted} repeat settlement(s) were accepted"
      )
      |> check(duplicate.other != 0, "repeat settlement raised an unexpected error")
      |> check(
        truth.states != %{"succeeded" => level},
        "terminal states #{inspect(truth.states)}"
      )
      |> check(truth.runs_succeeded != level, "#{truth.runs_succeeded} succeeded runs")
      |> check(
        truth.events["job.queued"] != level,
        "job.queued events #{truth.events["job.queued"]}"
      )
      |> check(
        truth.events["job.claimed"] != level,
        "job.claimed events #{truth.events["job.claimed"]}"
      )
      |> check(
        truth.events["job.succeeded"] != level,
        "job.succeeded events #{truth.events["job.succeeded"]}"
      )
      |> check(
        truth.duplicate_event_pairs != 0,
        "#{truth.duplicate_event_pairs} duplicated event pair(s)"
      )
      |> check(
        truth.outbox_rows != 3 * level,
        "outbox rows #{truth.outbox_rows} (expected #{3 * level})"
      )
      |> check(
        truth.bad_generations != 0,
        "#{truth.bad_generations} job(s) not on generation/attempt 1"
      )

    %{
      concurrency: level,
      db_pool_size: pool_size,
      kind: kind,
      enqueued: length(jobs),
      claimed: length(leases),
      unique_claimed: unique_claimed,
      duplicate_claims: duplicate_claims,
      missing: length(missing),
      claim_errors: claim_errors,
      settled_ok: settle.ok,
      settle_failures: settle.failures,
      settle_errors: settle.errors,
      duplicate_settle_refused: duplicate.refused,
      duplicate_settle_accepted: duplicate.accepted,
      states: truth.states,
      runs_succeeded: truth.runs_succeeded,
      events: truth.events,
      duplicate_event_pairs: truth.duplicate_event_pairs,
      outbox_rows: truth.outbox_rows,
      bad_generations: truth.bad_generations,
      elapsed_ms: elapsed_ms,
      violations: violations
    }
  end

  defp check(violations, false, _message), do: violations
  defp check(violations, true, message), do: violations ++ [message]

  # --------------------------------------------------------------------- claims

  defp claim_phase(worker, level, suite, kind, lease_ms) do
    results =
      1..level
      |> Task.async_stream(
        fn i ->
          claim_until_empty(worker, "#{suite}_w#{level}_#{i}", kind, lease_ms)
        end,
        max_concurrency: level,
        timeout: @claim_timeout_ms,
        ordered: false
      )
      |> Enum.map(fn
        {:ok, result} -> result
        {:exit, reason} -> {:error, {:claim_task_exit, reason}}
      end)

    # A worker can see an empty queue while another claim still holds the last
    # row's lock; drain on this process so "nothing left" is final, not a race.
    Enum.concat(results, [claim_until_empty(worker, "#{suite}_drain#{level}", kind, lease_ms)])
  end

  defp claim_until_empty(conn, worker_id, kind, lease_ms, acc \\ []) do
    case Postgres.claim(conn, worker_id, [kind], lease_ms) do
      {:ok, nil} -> {:ok, Enum.reverse(acc)}
      {:ok, %{lease: lease}} -> claim_until_empty(conn, worker_id, kind, lease_ms, [lease | acc])
      {:error, error} -> {:error, error}
    end
  end

  # -------------------------------------------------------------------- settling

  defp settle_phase(worker, leases, level) do
    results =
      leases
      |> Task.async_stream(
        fn lease -> Postgres.settle(worker, lease, "succeeded") end,
        max_concurrency: level,
        timeout: @claim_timeout_ms,
        ordered: false
      )
      |> Enum.map(fn
        {:ok, result} -> result
        {:exit, reason} -> {:error, {:settle_task_exit, reason}}
      end)

    ok = Enum.count(results, &match?({:ok, _}, &1))
    errors = for {:error, error} <- results, do: inspect(error)
    %{ok: ok, failures: length(errors), errors: errors}
  end

  defp duplicate_settle_phase(worker, leases) do
    Enum.reduce(leases, %{refused: 0, accepted: 0, other: 0}, fn lease, acc ->
      case Postgres.settle(worker, lease, "succeeded") do
        {:error, %Queue.StaleLeaseError{}} -> %{acc | refused: acc.refused + 1}
        {:ok, _job} -> %{acc | accepted: acc.accepted + 1}
        {:error, _other} -> %{acc | other: acc.other + 1}
      end
    end)
  end

  # ------------------------------------------------------------------- ledger

  defp ledger_truth(admin, org, jobs) do
    %{
      states: states(admin, org, jobs),
      runs_succeeded: scalar(admin, runs_sql(), [org, jobs]),
      events: events(admin, org, jobs),
      duplicate_event_pairs: scalar(admin, duplicate_events_sql(), [org, jobs]),
      outbox_rows: scalar(admin, outbox_sql(), [org, jobs]),
      bad_generations: scalar(admin, generations_sql(), [org, jobs])
    }
  end

  defp states(admin, org, jobs) do
    %Postgrex.Result{rows: rows} =
      Postgrex.query!(
        admin,
        "SELECT state, count(*) FROM uap.task_jobs
         WHERE organization_id=$1 AND id=ANY($2::text[]) GROUP BY state",
        [org, jobs]
      )

    Map.new(rows, fn [state, count] -> {state, count} end)
  end

  defp events(admin, org, jobs) do
    %Postgrex.Result{rows: rows} =
      Postgrex.query!(
        admin,
        "SELECT event_type, count(*) FROM uap.job_events
         WHERE organization_id=$1 AND job_id=ANY($2::text[]) GROUP BY event_type",
        [org, jobs]
      )

    Map.new(rows, fn [type, count] -> {type, count} end)
  end

  defp runs_sql do
    "SELECT count(*) FROM uap.agent_runs
     WHERE organization_id=$1 AND job_id=ANY($2::text[]) AND state='succeeded'"
  end

  defp duplicate_events_sql do
    "SELECT count(*) FROM (
       SELECT job_id, event_type FROM uap.job_events
       WHERE organization_id=$1 AND job_id=ANY($2::text[])
       GROUP BY job_id, event_type HAVING count(*) > 1
     ) duplicated"
  end

  defp outbox_sql do
    "SELECT count(*) FROM uap.job_outbox
     WHERE organization_id=$1 AND job_id=ANY($2::text[])"
  end

  defp generations_sql do
    "SELECT count(*) FROM uap.task_jobs
     WHERE organization_id=$1 AND id=ANY($2::text[])
       AND (lease_generation <> 1 OR attempt_count <> 1)"
  end

  defp scalar(conn, sql, params) do
    %Postgrex.Result{rows: [[value]]} = Postgrex.query!(conn, sql, params)
    value
  end
end
