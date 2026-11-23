defmodule AgentosWorker.Staging.ConcurrencyTest do
  @moduledoc """
  Staging concurrency drill for the durable queue (M2-12 / V6-06-03).

  One workload at 1, 10 and 100 concurrent worker processes, against a real
  PostgreSQL queue: every enqueued job must be claimed exactly once, settled
  exactly once, a repeat settlement must be refused, and the ledger must show
  one run and one claimed/succeeded event per job with no job left running.

  Tagged `:staging`, so `mix test`/`mix check` never need a database; run it
  with `mix test.staging` (disposable database) or point
  `TEST_DATABASE_URL`/`TEST_WORKER_DATABASE_URL` at a staging database.
  """
  use ExUnit.Case, async: false

  alias AgentosWorker.Queue.Postgres
  alias AgentosWorker.Staging.Concurrency

  @moduletag :staging
  @moduletag timeout: 600_000

  setup_all do
    worker_url = System.fetch_env!("TEST_WORKER_DATABASE_URL")
    admin_url = System.fetch_env!("TEST_DATABASE_URL")

    # The worker login holds no table privileges; the admin login seeds fixtures.
    {:ok, worker} =
      Postgres.start_link(url: worker_url, name: :staging_worker_pool, pool_size: 20)

    {:ok, admin} = Postgres.start_link(url: admin_url, name: :staging_admin, pool_size: 1)

    %{worker: worker, admin: admin}
  end

  test "1/10/100 concurrent workers claim and settle every job exactly once", ctx do
    {:ok, report} =
      Concurrency.run(worker: ctx.worker, admin: ctx.admin, levels: [1, 10, 100], pool_size: 20)

    assert Enum.map(report.levels, & &1.concurrency) == [1, 10, 100]
    assert report.violations == [], "staging drill violations: #{inspect(report.violations)}"

    for level <- report.levels do
      assert level.enqueued == level.concurrency
      assert level.claimed == level.concurrency
      assert level.unique_claimed == level.concurrency
      assert level.settled_ok == level.concurrency
      assert level.settle_failures == 0
      assert level.duplicate_settle_refused == level.concurrency
      assert level.duplicate_settle_accepted == 0
      assert level.states == %{"succeeded" => level.concurrency}
      assert level.runs_succeeded == level.concurrency
      assert level.duplicate_event_pairs == 0
      assert level.outbox_rows == 3 * level.concurrency
      assert is_integer(level.elapsed_ms) and level.elapsed_ms >= 0
    end

    path =
      System.get_env("STAGING_REPORT_PATH") ||
        Path.expand("../../../../../tests/out/elixir/staging-concurrency.json", __DIR__)

    File.mkdir_p!(Path.dirname(path))
    File.write!(path, Jason.encode!(report, pretty: true) <> "\n")
    assert File.exists?(path)
  end
end
