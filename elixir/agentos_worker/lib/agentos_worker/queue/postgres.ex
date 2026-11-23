defmodule AgentosWorker.Queue.Postgres do
  @moduledoc """
  Postgres adapter for the single durable queue (V6-06-03).

  Every function here calls one of the `uap` transition functions granted to the
  worker login; none of them runs a raw `INSERT`/`UPDATE` against queue tables.
  The adapter owns the in-memory half of fencing: it mints the lease token,
  stores only its SHA-256 hex in the database (through the transition function),
  and presents `{generation, token}` on every later call.
  """
  require Logger

  alias AgentosWorker.Queue
  alias AgentosWorker.Queue.{InvalidInputError, StaleLeaseError, TransitionError}

  @default_lease_ms 60_000
  @default_outbox_limit 50
  @default_outbox_lock_ms 30_000

  @doc """
  Starts the connection pool used by the worker application.

  Options are passed to `Postgrex` (`:url`, `:hostname`, `:username`, ...). A
  `:url` is parsed here because Postgrex 0.17 does not accept one directly; an
  invalid URL is a caller error and raises rather than silently connecting to
  the wrong database.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    {name, opts} = Keyword.pop(opts, :name)
    opts = opts |> Keyword.put_new(:pool_size, 1) |> expand_url()
    Postgrex.start_link(if(name, do: Keyword.put(opts, :name, name), else: opts))
  end

  @doc false
  def expand_url(opts) do
    case Keyword.pop(opts, :url) do
      {nil, opts} ->
        opts

      {url, opts} ->
        uri = URI.parse(url)

        unless uri.host && uri.path not in [nil, ""] do
          raise ArgumentError, "queue url must include a host and a database"
        end

        {username, password} = credentials(uri.userinfo)

        Keyword.merge(
          [
            hostname: uri.host,
            port: uri.port || 5432,
            database: String.trim_leading(uri.path, "/")
          ],
          opts
        )
        |> maybe_put(:username, username)
        |> maybe_put(:password, password)
    end
  end

  defp credentials(nil), do: {nil, nil}

  defp credentials(userinfo) do
    case String.split(userinfo, ":", parts: 2) do
      [user, password] -> {URI.decode(user), URI.decode(password)}
      [user] -> {URI.decode(user), nil}
    end
  end

  defp maybe_put(opts, _key, nil), do: opts
  defp maybe_put(opts, key, value), do: Keyword.put(opts, key, value)

  @doc "Claims at most one job of the given kinds and returns its fenced lease."
  @spec claim(GenServer.server(), String.t(), [String.t()], non_neg_integer()) ::
          {:ok, %{lease: Queue.t(), job: map()}} | {:ok, nil} | {:error, Exception.t()}
  def claim(conn, worker_id, kinds, lease_ms \\ @default_lease_ms) do
    with :ok <- validate_worker_id(worker_id),
         :ok <- validate_kinds(kinds),
         :ok <- validate_lease_ms(lease_ms) do
      token = Queue.new_token()
      hash = Queue.token_hash(token)

      case query(conn, "SELECT * FROM uap.claim_task_job($1,$2,$3,$4)", [
             worker_id,
             kinds,
             lease_ms,
             hash
           ]) do
        {:ok, %{rows: []}} ->
          {:ok, nil}

        {:ok, %{columns: columns, rows: [row]}} ->
          job = Map.new(Enum.zip(columns, row))

          case Queue.lease(
                 job["organization_id"],
                 job["id"],
                 job["lease_generation"],
                 token,
                 job["lease_expires_at"]
               ) do
            {:ok, lease} ->
              {:ok, %{lease: lease, job: job}}

            {:error, :invalid_lease} ->
              {:error, %InvalidInputError{message: "claim returned an unusable lease"}}
          end

        {:ok, %{rows: rows}} when length(rows) > 1 ->
          {:error, %InvalidInputError{message: "claim returned more than one job"}}

        {:error, error} ->
          {:error, translate(error, nil)}
      end
    else
      {:error, error} -> {:error, error}
    end
  end

  @doc "Extends the lease. A stale generation or foreign token is refused without mutating the job."
  @spec heartbeat(GenServer.server(), Queue.t(), non_neg_integer()) ::
          {:ok, map()} | {:error, Exception.t()}
  def heartbeat(conn, %Queue{} = lease, lease_ms \\ @default_lease_ms) do
    with {:ok, lease} <- Queue.validate(lease),
         :ok <- validate_lease_ms(lease_ms) do
      params = [
        lease.organization_id,
        lease.job_id,
        lease.generation,
        Queue.token_hash(lease.token),
        lease_ms
      ]

      case query(conn, "SELECT * FROM uap.heartbeat_task_job($1,$2,$3,$4,$5)", params) do
        {:ok, %{columns: columns, rows: [row]}} -> {:ok, Map.new(Enum.zip(columns, row))}
        {:ok, %{rows: []}} -> {:error, stale(lease)}
        {:error, error} -> {:error, translate(error, lease)}
      end
    else
      {:error, error} -> {:error, error}
    end
  end

  @doc """
  Settles the attempt. `retry_in_ms` schedules another attempt (the database
  decides between requeue, incomplete and dead-letter); it does not retry blindly.
  """
  @spec settle(GenServer.server(), Queue.t(), String.t(), keyword()) ::
          {:ok, map()} | {:error, Exception.t()}
  def settle(conn, %Queue{} = lease, outcome, opts \\ []) do
    retry_in_ms = Keyword.get(opts, :retry_in_ms)
    result = Keyword.get(opts, :result)
    error_payload = Keyword.get(opts, :error)

    with {:ok, lease} <- Queue.validate(lease),
         :ok <- validate_outcome(outcome),
         :ok <- validate_retry(retry_in_ms) do
      params = [
        lease.organization_id,
        lease.job_id,
        lease.generation,
        Queue.token_hash(lease.token),
        outcome,
        retry_in_ms,
        result,
        error_payload
      ]

      case query(conn, "SELECT * FROM uap.settle_task_job($1,$2,$3,$4,$5,$6,$7,$8)", params) do
        {:ok, %{columns: columns, rows: [row]}} -> {:ok, Map.new(Enum.zip(columns, row))}
        {:ok, %{rows: []}} -> {:error, stale(lease)}
        {:error, error} -> {:error, translate(error, lease)}
      end
    else
      {:error, error} -> {:error, error}
    end
  end

  @doc """
  Claims a batch of undelivered outbox events for this relay.

  The update takes an exclusive delivery lease (`locked_by`), so two relays never
  publish the same row concurrently; after a crash the lease expires and the row
  is reclaimable (at-least-once delivery, keyed by `event_id`).
  """
  @spec claim_outbox(GenServer.server(), String.t(), keyword()) ::
          {:ok, [map()]} | {:error, Exception.t()}
  def claim_outbox(conn, relay_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, @default_outbox_limit)
    lock_ms = Keyword.get(opts, :lock_ms, @default_outbox_lock_ms)

    with :ok <- validate_relay_id(relay_id),
         :ok <- validate_limit(limit),
         :ok <- validate_lock_ms(lock_ms) do
      case query(conn, "SELECT * FROM uap.claim_job_outbox($1,$2,$3)", [relay_id, limit, lock_ms]) do
        {:ok, %{columns: columns, rows: rows}} ->
          {:ok, Enum.map(rows, &Map.new(Enum.zip(columns, &1)))}

        {:error, error} ->
          {:error, translate(error, nil)}
      end
    else
      {:error, error} -> {:error, error}
    end
  end

  @doc "Marks a held event published. Returns `{:ok, false}` when this relay does not hold it."
  @spec mark_published(GenServer.server(), String.t(), String.t()) ::
          {:ok, boolean()} | {:error, Exception.t()}
  def mark_published(conn, relay_id, event_id) do
    with :ok <- validate_relay_id(relay_id),
         :ok <- validate_event_id(event_id) do
      case query(conn, "SELECT uap.mark_job_outbox_published($1,$2) AS ok", [event_id, relay_id]) do
        {:ok, %{rows: [[ok]]}} -> {:ok, ok}
        {:ok, %{rows: []}} -> {:ok, false}
        {:error, error} -> {:error, translate(error, nil)}
      end
    else
      {:error, error} -> {:error, error}
    end
  end

  @doc """
  Releases a held event after a failed delivery.

  Returns the database's decision: `"retry"` (attempt recorded, backoff applied),
  `"dead"` (attempt ceiling reached, never claimable again), `"stale"` (another
  relay holds it), `"settled"` (already published or dead) or `"missing"`.
  """
  @spec release(GenServer.server(), String.t(), String.t(), keyword()) ::
          {:ok, String.t()} | {:error, Exception.t()}
  def release(conn, relay_id, event_id, opts \\ []) do
    retry_in_ms = Keyword.get(opts, :retry_in_ms, 0)
    error_text = Keyword.get(opts, :error, "")
    max_attempts = Keyword.get(opts, :max_attempts, 5)

    with :ok <- validate_relay_id(relay_id),
         :ok <- validate_event_id(event_id),
         :ok <- validate_retry(retry_in_ms),
         :ok <- validate_max_attempts(max_attempts) do
      params = [event_id, relay_id, retry_in_ms, to_string(error_text), max_attempts]

      case query(conn, "SELECT uap.release_job_outbox($1,$2,$3,$4,$5) AS state", params) do
        {:ok, %{rows: [[state]]}} -> {:ok, state}
        {:ok, %{rows: []}} -> {:ok, "missing"}
        {:error, error} -> {:error, translate(error, nil)}
      end
    else
      {:error, error} -> {:error, error}
    end
  end

  @doc "Truthful delivery counters for the worker health surface."
  @spec outbox_state(GenServer.server()) :: {:ok, map()} | {:error, Exception.t()}
  def outbox_state(conn) do
    case query(conn, "SELECT * FROM uap.job_outbox_state()", []) do
      {:ok, %{columns: columns, rows: [row]}} -> {:ok, Map.new(Enum.zip(columns, row))}
      {:ok, %{rows: []}} -> {:ok, %{}}
      {:error, error} -> {:error, translate(error, nil)}
    end
  end

  defp query(conn, sql, params), do: Postgrex.query(conn, sql, params)

  defp stale(lease) do
    %StaleLeaseError{
      message: "lease is no longer current for job #{lease.job_id}",
      organization_id: lease.organization_id,
      job_id: lease.job_id,
      generation: lease.generation
    }
  end

  defp translate(%Postgrex.Error{message: message} = error, lease) do
    case pg_code(error) do
      "P0002" -> if lease, do: stale(lease), else: %StaleLeaseError{message: message}
      "P0003" -> %InvalidInputError{message: message}
      "P0001" -> %TransitionError{message: message}
      _other -> error
    end
  end

  defp translate(other, _lease), do: other

  defp pg_code(%Postgrex.Error{postgres: postgres}) when is_map(postgres) do
    code = Map.get(postgres, :pg_code) || Map.get(postgres, :code)
    if is_binary(code), do: code, else: nil
  end

  defp pg_code(_error), do: nil

  defp validate_worker_id(value) when is_binary(value) do
    if byte_size(value) in 1..200, do: :ok, else: invalid("worker id must be 1..200 bytes")
  end

  defp validate_worker_id(_value), do: invalid("worker id must be 1..200 bytes")

  defp validate_relay_id(value) when is_binary(value) do
    if byte_size(value) in 1..200, do: :ok, else: invalid("relay id must be 1..200 bytes")
  end

  defp validate_relay_id(_value), do: invalid("relay id must be 1..200 bytes")

  defp validate_event_id(value) when is_binary(value) do
    if byte_size(value) in 1..200, do: :ok, else: invalid("event id must be 1..200 bytes")
  end

  defp validate_event_id(_value), do: invalid("event id must be 1..200 bytes")

  defp validate_kinds(kinds) when is_list(kinds) and kinds != [] and length(kinds) <= 50 do
    if Enum.all?(kinds, &(is_binary(&1) and Regex.match?(~r/^[a-z0-9][a-z0-9._-]{0,99}$/, &1))) do
      :ok
    else
      invalid("kinds must be lowercase dotted identifiers")
    end
  end

  defp validate_kinds(_kinds),
    do: invalid("kinds must be a non-empty list of at most 50 identifiers")

  defp validate_lease_ms(value) when is_integer(value) and value in 1_000..1_800_000, do: :ok
  defp validate_lease_ms(_value), do: invalid("lease duration must be 1000..1800000 ms")

  defp validate_lock_ms(value) when is_integer(value) and value in 1_000..600_000, do: :ok
  defp validate_lock_ms(_value), do: invalid("outbox lock must be 1000..600000 ms")

  defp validate_limit(value) when is_integer(value) and value in 1..500, do: :ok
  defp validate_limit(_value), do: invalid("outbox batch must be 1..500")

  defp validate_outcome(outcome) when outcome in ~w(succeeded failed incomplete cancelled),
    do: :ok

  defp validate_outcome(_outcome),
    do: invalid("outcome must be succeeded|failed|incomplete|cancelled")

  defp validate_retry(nil), do: :ok
  defp validate_retry(value) when is_integer(value) and value in 0..3_600_000, do: :ok
  defp validate_retry(_value), do: invalid("retry delay must be 0..3600000 ms")

  defp validate_max_attempts(value) when is_integer(value) and value in 1..100, do: :ok
  defp validate_max_attempts(_value), do: invalid("max attempts must be 1..100")

  defp invalid(message), do: {:error, %InvalidInputError{message: message}}
end
