defmodule AgentosWorker.StatusTest do
  use ExUnit.Case, async: false

  setup do
    AgentosWorker.TaskSupervisor
    |> DynamicSupervisor.which_children()
    |> Enum.each(fn {_, pid, _, _} ->
      DynamicSupervisor.terminate_child(AgentosWorker.TaskSupervisor, pid)
    end)

    :ok
  end

  test "reports the real running supervisor pids and version" do
    status = AgentosWorker.status()

    assert status.app == :agentos_worker
    assert status.registry == Process.whereis(AgentosWorker.Registry)
    assert status.task_supervisor == Process.whereis(AgentosWorker.TaskSupervisor)
    assert status.version == to_string(Application.spec(:agentos_worker, :vsn))
    assert status.tasks == 0
  end

  test "counts live tasks rather than reporting a configured or remembered number" do
    for _ <- 1..3 do
      key = "count-#{System.unique_integer([:positive])}"

      {:ok, _} =
        DynamicSupervisor.start_child(
          AgentosWorker.TaskSupervisor,
          {AgentosWorker.TestProbe, key}
        )
    end

    assert AgentosWorker.status().tasks == 3
  end

  test "reports :down honestly when the task supervisor is gone" do
    :ok = Supervisor.terminate_child(AgentosWorker.Supervisor, AgentosWorker.TaskSupervisor)

    on_exit(fn ->
      {:ok, _} = Supervisor.restart_child(AgentosWorker.Supervisor, AgentosWorker.TaskSupervisor)
    end)

    status = AgentosWorker.status()
    assert status.task_supervisor == nil
    assert status.tasks == nil
  end
end
