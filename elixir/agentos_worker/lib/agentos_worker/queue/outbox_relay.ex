defmodule AgentosWorker.Queue.OutboxRelay do
  @moduledoc """
  Delivers committed queue events to the rest of the organism (V6-06-03).

  The relay is deliberately stateless about *what* it delivered: every poll claims
  unpublished rows from `uap.job_outbox` under an exclusive delivery lease, hands
  each event to the configured publisher, then marks it published or releases it
  with exponential backoff. All progress lives in the database, so a crash or a
  restart resumes from the table — there is no in-memory delivery cursor to lose.

  Delivery is **at-least-once**. A crash between a successful publish and the
  mark republishes the same `event_id`; consumers must key on it. A relay that
  lost its delivery lease (a slow publish past `lock_ms`) cannot mark or release
  a row it no longer holds — the database returns `false`/`"stale"` and the relay
  records the loss instead of pretending success.

  Publisher contract: a function of one event map (string keys, as returned by
  `AgentosWorker.Queue.Postgres.claim_outbox/3`) that returns `:ok` or
  `{:error, reason}`. Anything else is treated as a failure and retried.
  """
  use GenServer
  require Logger

  alias AgentosWorker.Queue.Postgres

  @name __MODULE__
  @defaults %{
    batch_size: 50,
    lock_ms: 30_000,
    max_attempts: 5,
    poll_interval_ms: 1_000,
    base_backoff_ms: 250,
    max_backoff_ms: 30_000
  }

  @doc """
  Starts the relay.

  Required options: `:conn` (queue connection) and `:publisher` (arity-1 fun).
  Optional: `:relay_id`, `:name`, plus the tunables in `@defaults`.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    name = Keyword.get(opts, :name, @name)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc false
  def child_spec(opts) do
    %{id: Keyword.get(opts, :name, @name), start: {__MODULE__, :start_link, [opts]}}
  end

  @doc """
  Returns `{:ok, status}` with this run's counters and the database's truthful
  delivery state (or `nil` when the database read failed).
  """
  @spec status(GenServer.server()) :: {:ok, map()}
  def status(server \\ @name), do: GenServer.call(server, :status, 5_000)

  @doc "Wakes the relay immediately instead of waiting for the next poll."
  @spec poll_now(GenServer.server()) :: :ok
  def poll_now(server \\ @name), do: GenServer.cast(server, :poll_now)

  @impl true
  def init(opts) do
    conn = Keyword.fetch!(opts, :conn)
    publisher = Keyword.fetch!(opts, :publisher)

    unless is_function(publisher, 1) do
      raise ArgumentError, "publisher must be an arity-1 function"
    end

    settings =
      @defaults
      |> Map.merge(Map.new(Keyword.take(opts, Map.keys(@defaults))))
      |> Map.put(:conn, conn)
      |> Map.put(:publisher, publisher)
      |> Map.put(:relay_id, Keyword.get(opts, :relay_id, default_relay_id()))

    state =
      Map.merge(settings, %{
        polls: 0,
        published: 0,
        retried: 0,
        dead: 0,
        lost: 0,
        last_error: nil
      })

    send(self(), :poll)
    {:ok, state}
  end

  @impl true
  def handle_call(:status, _from, state) do
    database =
      case Postgres.outbox_state(state.conn) do
        {:ok, counters} -> counters
        {:error, reason} -> %{"error" => inspect(reason)}
      end

    {:reply,
     {:ok,
      %{
        "relay_id" => state.relay_id,
        "polls" => state.polls,
        "published" => state.published,
        "retried" => state.retried,
        "dead" => state.dead,
        "lost" => state.lost,
        "last_error" => state.last_error,
        "outbox" => database
      }}, state}
  end

  @impl true
  def handle_cast(:poll_now, state) do
    {state, delivered} = drain(state)
    schedule(state, delivered)
    {:noreply, state}
  end

  @impl true
  def handle_info(:poll, state) do
    {state, delivered} = drain(state)
    schedule(state, delivered)
    {:noreply, %{state | polls: state.polls + 1}}
  end

  defp schedule(state, delivered) do
    # A full batch means there is probably more waiting: poll again immediately.
    delay = if delivered >= state.batch_size, do: 0, else: state.poll_interval_ms
    Process.send_after(self(), :poll, delay)
  end

  defp drain(state) do
    case Postgres.claim_outbox(state.conn, state.relay_id,
           limit: state.batch_size,
           lock_ms: state.lock_ms
         ) do
      {:ok, []} ->
        {state, 0}

      {:ok, events} ->
        state = Enum.reduce(events, state, &deliver(&2, &1))
        if length(events) >= state.batch_size, do: drain(state), else: {state, length(events)}

      {:error, reason} ->
        Logger.error("outbox claim failed: #{inspect(reason)}")
        {%{state | last_error: inspect(reason)}, 0}
    end
  end

  defp deliver(state, event) do
    result =
      try do
        state.publisher.(event)
      catch
        kind, reason -> {:error, "publisher #{kind}: #{inspect(reason)}"}
      end

    case result do
      :ok -> mark_published(state, event)
      {:error, reason} -> release(state, event, to_string(reason))
      other -> release(state, event, "publisher returned #{inspect(other)}")
    end
  end

  defp mark_published(state, event) do
    case Postgres.mark_published(state.conn, state.relay_id, event["event_id"]) do
      {:ok, true} ->
        %{state | published: state.published + 1}

      {:ok, false} ->
        Logger.warning("outbox delivery lease lost before mark", event_id: event["event_id"])
        %{state | lost: state.lost + 1, last_error: "delivery lease lost before mark"}

      {:error, reason} ->
        %{state | last_error: inspect(reason)}
    end
  end

  defp release(state, event, reason) do
    backoff = backoff(state, event["attempts"] || 0)

    case Postgres.release(state.conn, state.relay_id, event["event_id"],
           retry_in_ms: backoff,
           error: reason,
           max_attempts: state.max_attempts
         ) do
      {:ok, "dead"} ->
        Logger.error("outbox event dead-lettered", event_id: event["event_id"], error: reason)
        %{state | dead: state.dead + 1, last_error: reason}

      {:ok, "retry"} ->
        %{state | retried: state.retried + 1, last_error: reason}

      {:ok, "stale"} ->
        %{state | lost: state.lost + 1, last_error: "delivery lease lost before release"}

      {:ok, _settled} ->
        state

      {:error, error} ->
        %{state | last_error: inspect(error)}
    end
  end

  defp backoff(state, attempts) do
    scaled = state.base_backoff_ms * Integer.pow(2, min(attempts, 10))
    min(scaled, state.max_backoff_ms)
  end

  defp default_relay_id do
    "relay_" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
  end
end
