defmodule AgentosWorker.ScaffoldTest do
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog

  setup do
    clear_tasks()
    :ok
  end

  test "application boots one supervisor owning the registry and the task supervisor" do
    sup = Process.whereis(AgentosWorker.Supervisor)
    assert is_pid(sup), "AgentosWorker.Supervisor must be the application's root supervisor"

    ids = sup |> Supervisor.which_children() |> Enum.map(&elem(&1, 0))
    assert AgentosWorker.Registry in ids
    assert AgentosWorker.TaskSupervisor in ids

    assert is_pid(Process.whereis(AgentosWorker.Registry))
    assert is_pid(Process.whereis(AgentosWorker.TaskSupervisor))
  end

  test "registry is unique: a second process cannot claim a key already held" do
    key = "unique-key-#{System.unique_integer([:positive])}"

    {:ok, first} =
      DynamicSupervisor.start_child(AgentosWorker.TaskSupervisor, {AgentosWorker.TestProbe, key})

    assert AgentosWorker.Registry.whereis(key) == first
    assert {:error, {:already_started, ^first}} = AgentosWorker.TestProbe.start_link(key)
  end

  test "task supervisor starts children under :one_for_one and reclaims their registry keys" do
    key = "one-for-one-#{System.unique_integer([:positive])}"

    {:ok, probe} =
      DynamicSupervisor.start_child(AgentosWorker.TaskSupervisor, {AgentosWorker.TestProbe, key})

    assert %{active: 1} = DynamicSupervisor.count_children(AgentosWorker.TaskSupervisor)

    ref = Process.monitor(probe)

    log =
      capture_log(fn ->
        AgentosWorker.TestProbe.crash(probe)
        assert_receive {:DOWN, ^ref, :process, ^probe, _reason}, 1_000
      end)

    assert log =~ "probe crash requested by test"

    # The registry entry is reclaimed by the registry itself, not by application code.
    assert AgentosWorker.Registry.whereis(key) == nil

    # :one_for_one keeps the supervisor alive; it does not take siblings down.
    assert is_pid(Process.whereis(AgentosWorker.TaskSupervisor))
    assert %{active: 0} = DynamicSupervisor.count_children(AgentosWorker.TaskSupervisor)
  end

  defp clear_tasks do
    AgentosWorker.TaskSupervisor
    |> DynamicSupervisor.which_children()
    |> Enum.each(fn {_, pid, _, _} ->
      DynamicSupervisor.terminate_child(AgentosWorker.TaskSupervisor, pid)
    end)
  end
end
