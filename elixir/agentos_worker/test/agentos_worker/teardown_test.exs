defmodule AgentosWorker.TeardownTest do
  use ExUnit.Case, async: false

  setup do
    AgentosWorker.TaskSupervisor
    |> DynamicSupervisor.which_children()
    |> Enum.each(fn {_, pid, _, _} ->
      DynamicSupervisor.terminate_child(AgentosWorker.TaskSupervisor, pid)
    end)

    :ok
  end

  test "terminating a task ends the process and leaves no registry entry behind" do
    key = "teardown-#{System.unique_integer([:positive])}"

    {:ok, pid} =
      DynamicSupervisor.start_child(AgentosWorker.TaskSupervisor, {AgentosWorker.TestProbe, key})

    ref = Process.monitor(pid)

    assert :ok = DynamicSupervisor.terminate_child(AgentosWorker.TaskSupervisor, pid)
    assert_receive {:DOWN, ^ref, :process, ^pid, :shutdown}
    refute Process.alive?(pid)
    assert AgentosWorker.Registry.whereis(key) == nil
    assert %{active: 0} = DynamicSupervisor.count_children(AgentosWorker.TaskSupervisor)
  end

  test "terminating an already-dead pid is an error, not a silent success" do
    key = "gone-#{System.unique_integer([:positive])}"

    {:ok, pid} =
      DynamicSupervisor.start_child(AgentosWorker.TaskSupervisor, {AgentosWorker.TestProbe, key})

    :ok = DynamicSupervisor.terminate_child(AgentosWorker.TaskSupervisor, pid)

    assert {:error, :not_found} =
             DynamicSupervisor.terminate_child(AgentosWorker.TaskSupervisor, pid)
  end
end
