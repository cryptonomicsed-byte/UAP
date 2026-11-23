defmodule AgentosWorker.Application do
  @moduledoc """
  Root supervision tree for the ephemeral worker.

  Two long-lived children only:

    * `AgentosWorker.Registry` — unique-key process registry keyed by task id;
    * `AgentosWorker.TaskSupervisor` — one `:one_for_one` DynamicSupervisor that
      owns every ephemeral task process, so a task crash never takes the worker
      application down and teardown is a single `terminate_child/2`.

  Postgres remains the truth about queue state and receipts (architecture freeze
  authority #4). Nothing here is allowed to remember task state.
  """
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      {Registry, keys: :unique, name: AgentosWorker.Registry},
      {DynamicSupervisor, strategy: :one_for_one, name: AgentosWorker.TaskSupervisor}
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: AgentosWorker.Supervisor)
  end
end
