defmodule AgentosWorker.TaskWorkerTest do
  use ExUnit.Case, async: false

  alias AgentosWorker.{Lease, LeaseFactory, Registry, TaskWorker}
  alias AgentosWorker.JSONTestDecoder, as: JSON

  # Every test gets its own task id so the (global, unique) task registry cannot
  # collide across tests or with the scaffold suite's probes.
  defp spec(lease_overrides \\ %{}, task_overrides \\ %{}) do
    id = "task-#{System.unique_integer([:positive])}"
    lease_overrides = Map.put_new(lease_overrides, "task_id", id)
    task_overrides = Map.put_new(task_overrides, :task_id, id)
    LeaseFactory.spec(lease_overrides, task_overrides)
  end

  test "starts with the exact SID, immutable role+skill digests and signed lease" do
    spec = spec()

    assert {:ok, pid} = TaskWorker.start_link(spec)
    assert {:ok, binding} = TaskWorker.binding(pid)

    assert binding.task_id == spec.task.task_id
    assert binding.sid == "sid_test01"
    assert binding.tenant == "acme"
    assert binding.role_digest == spec.task.role_digest
    assert binding.skill_digest == spec.task.skill_digest
    assert binding.lease_id == "lease-t1"
    assert binding.grant_id == "grant-t1"
    assert binding.epoch == 1
    assert binding.revocation == %{list: "revocations-acme", version: 1}
    assert binding.lease_expires_at_ms == spec.lease["expires_at_ms"]

    assert {:ok, %{status: :running, sid: "sid_test01"}} = TaskWorker.status(pid)
  end

  test "refuses a lease for another SID" do
    assert {:error, :sid_mismatch} = TaskWorker.start_link(spec(%{"sid" => "sid_other01"}))
  end

  test "refuses a lease for another tenant" do
    assert {:error, :tenant_mismatch} = TaskWorker.start_link(spec(%{"tenant" => "globex"}))
  end

  test "refuses a lease for another task" do
    assert {:error, :task_mismatch} = TaskWorker.start_link(spec(%{"task_id" => "task-other"}))
  end

  test "refuses a lease pinning another role digest" do
    assert {:error, :role_digest_mismatch} =
             TaskWorker.start_link(spec(%{"role_digest" => String.duplicate("cc", 32)}))
  end

  test "refuses a lease edited after signing" do
    spec = spec()
    tampered = %{spec.lease | "sid" => "sid_evil01"}
    task = %{spec.task | sid: "sid_evil01"}

    assert {:error, :lease_signature} =
             TaskWorker.start_link(%{spec | lease: tampered, task: task})
  end

  test "refuses a lease with a field outside the contract" do
    assert {:error, :lease_schema} = TaskWorker.start_link(spec(%{"note" => "extra"}))
  end

  test "refuses an expired lease" do
    now = System.system_time(:millisecond)
    spec = spec(%{"issued_at_ms" => now - 60_000, "expires_at_ms" => now - 1_000})
    assert {:error, :lease_expired} = TaskWorker.start_link(spec)
  end

  test "refuses a lease that is not valid yet" do
    now = System.system_time(:millisecond)
    spec = spec(%{"issued_at_ms" => now + 60_000, "expires_at_ms" => now + 120_000})
    assert {:error, :lease_not_yet_valid} = TaskWorker.start_link(spec)
  end

  test "refuses epoch 0 and an inverted window" do
    assert {:error, :lease_epoch} = TaskWorker.start_link(spec(%{"epoch" => 0}))

    now = System.system_time(:millisecond)
    inverted = spec(%{"issued_at_ms" => now + 5_000, "expires_at_ms" => now + 1_000})
    assert {:error, :lease_epoch} = TaskWorker.start_link(inverted)
  end

  test "refuses a SID outside the canonical grammar" do
    for bad <- ["sid_Test01", "ab", "sid bad", String.duplicate("9", 200)] do
      assert {:error, :invalid_sid} = TaskWorker.start_link(spec(%{"sid" => bad}, %{sid: bad}))
    end
  end

  test "refuses a non-digest skill pin" do
    assert {:error, :invalid_digest} = TaskWorker.start_link(spec(%{}, %{skill_digest: "abc"}))
  end

  test "refuses an incomplete task descriptor" do
    spec = spec()
    incomplete = Map.delete(spec.task, :tenant)
    assert {:error, :invalid_task} = TaskWorker.start_link(%{spec | task: incomplete})
  end

  test "rebind errors and leaves the binding unchanged" do
    assert {:ok, pid} = TaskWorker.start_link(spec())
    {:ok, before} = TaskWorker.binding(pid)

    assert {:error, :immutable_binding} = TaskWorker.rebind(pid, "sid_other01")
    assert {:ok, ^before} = TaskWorker.binding(pid)
  end

  test "one live worker per task, named through the task registry" do
    spec = spec()
    assert {:ok, pid} = TaskWorker.start_link(spec)
    assert Registry.whereis({:task, spec.task.task_id}) == pid

    assert {:error, {:already_started, ^pid}} = TaskWorker.start_link(spec)
    assert Registry.whereis({:task, spec.task.task_id}) == pid

    GenServer.stop(pid)
    assert Registry.whereis({:task, spec.task.task_id}) == nil
  end

  test "runs as a supervised child and shows up in the honest task count" do
    before = AgentosWorker.status().tasks
    spec = spec()

    assert {:ok, pid} =
             DynamicSupervisor.start_child(AgentosWorker.TaskSupervisor, {TaskWorker, spec})

    assert AgentosWorker.status().tasks == before + 1
    assert Registry.whereis({:task, spec.task.task_id}) == pid

    assert :ok = DynamicSupervisor.terminate_child(AgentosWorker.TaskSupervisor, pid)
    assert AgentosWorker.status().tasks == before
  end

  test "stops itself when the lease window closes" do
    now = System.system_time(:millisecond)
    spec = spec(%{"issued_at_ms" => now - 1_000, "expires_at_ms" => now + 300})

    assert {:ok, pid} = TaskWorker.start_link(spec)
    Process.unlink(pid)
    ref = Process.monitor(pid)

    assert_receive {:DOWN, ^ref, :process, ^pid, {:shutdown, :lease_expired}}, 2_000
  end

  test "reproduces the kernel's golden lease fixtures" do
    dir = Path.expand("../../../../crates/agentos-policy/fixtures", __DIR__)
    fixtures = Path.wildcard(Path.join(dir, "lease-*"))

    assert length(fixtures) == 5

    for fixture <- fixtures do
      expect = fixture |> Path.join("expect.txt") |> File.read!() |> String.trim()
      raw = fixture |> Path.join("fields.json") |> File.read!()
      sig = fixture |> Path.join("sig.hex") |> File.read!() |> String.trim()
      pub = fixture |> Path.join("issuer.pub.hex") |> File.read!() |> String.trim()
      want_sha = fixture |> Path.join("canonical.sha256") |> File.read!() |> String.trim()

      # A document carrying a boolean cannot decode under the lease schema; the
      # fixture that does expects "invalid", so a decode error is a verdict.
      got =
        case JSON.decode(raw) do
          {:ok, fields} -> fixture_verdict(fields, sig, pub, want_sha)
          {:error, _reason} -> "invalid"
        end

      assert got == expect, "#{Path.basename(fixture)}: expected #{expect}, got #{got}"
    end
  end

  defp fixture_verdict(fields, sig, pub, want_sha) do
    case Lease.verify(fields, sig, pub) do
      {:ok, body, sha} ->
        assert sha == want_sha, "canonical bytes differ"
        assert :crypto.hash(:sha256, body) |> Base.encode16(case: :lower) == want_sha
        "valid"

      {:error, _reason} ->
        "invalid"
    end
  end
end
