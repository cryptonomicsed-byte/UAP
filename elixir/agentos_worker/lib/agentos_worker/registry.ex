defmodule AgentosWorker.Registry do
  @moduledoc """
  Naming helpers for the unique task registry.

  The registry process itself is started by `AgentosWorker.Application` under the
  registered name `AgentosWorker.Registry`; this module only builds `:via` names
  so callers never hand-roll the tuple.
  """

  @doc "Returns the `:via` name for a task key (one process per key)."
  @spec via(term()) :: {:via, Registry, {module(), term()}}
  def via(key), do: {:via, Registry, {__MODULE__, key}}

  @doc "Returns the pid registered under `key`, or `nil` when no process holds it."
  @spec whereis(term()) :: pid() | nil
  def whereis(key) do
    case Registry.whereis_name({__MODULE__, key}) do
      :undefined -> nil
      pid -> pid
    end
  end
end
