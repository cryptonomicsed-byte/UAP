defmodule AgentosWorker.TestProbe do
  @moduledoc false
  # Minimal child process used to prove the task supervisor starts, names and
  # tears down children. It is deliberately dumb: no task semantics, no lease.
  # Ephemeral tasks are :temporary — a dead task is never silently restarted by
  # the supervisor; reconciliation is explicit work (M2-11).
  use GenServer

  def child_spec(key) do
    %{id: key, start: {__MODULE__, :start_link, [key]}, restart: :temporary, type: :worker}
  end

  def start_link(key),
    do: GenServer.start_link(__MODULE__, key, name: AgentosWorker.Registry.via(key))

  def crash(pid), do: GenServer.cast(pid, :crash)

  @impl true
  def init(key), do: {:ok, key}

  @impl true
  def handle_cast(:crash, _key), do: raise("probe crash requested by test")
end
