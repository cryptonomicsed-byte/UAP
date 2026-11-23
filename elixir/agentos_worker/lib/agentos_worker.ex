defmodule AgentosWorker do
  @moduledoc """
  Ephemeral task execution for UAP.

  This app is the **only** owner of ephemeral task lifecycle (architecture freeze
  authority #2). The supervision tree, the task registry, per-task workers with
  SID + signed lease, the Postgres queue adapter and the restart/cancel/UNCERTAIN
  reconciliation policy exist; checkpointing and secret wipe are separate items
  and are deliberately absent here.

  Status is read from the live supervisors, never from memory or config, and
  reports `nil` (not zero) when a supervisor is down — an idle worker and a dead
  worker must not look alike.
  """

  @spec status() :: %{
          app: :agentos_worker,
          version: String.t(),
          registry: pid() | nil,
          task_supervisor: pid() | nil,
          tasks: non_neg_integer() | nil
        }
  def status do
    %{
      app: :agentos_worker,
      version: version(),
      registry: Process.whereis(AgentosWorker.Registry),
      task_supervisor: Process.whereis(AgentosWorker.TaskSupervisor),
      tasks: task_count()
    }
  end

  defp version do
    :agentos_worker |> Application.spec(:vsn) |> to_string()
  end

  defp task_count do
    case Process.whereis(AgentosWorker.TaskSupervisor) do
      nil ->
        nil

      pid ->
        case DynamicSupervisor.count_children(pid) do
          %{active: active} -> active
        end
    end
  end
end
