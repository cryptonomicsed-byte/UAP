defmodule AgentosWorker.Queue do
  @moduledoc """
  The one durable queue boundary (V6-06-03).

  Decision, recorded so it cannot drift: **PostgreSQL is the single queue and
  ledger authority** (`uap.task_jobs`, `uap.job_events`, `uap.job_outbox`). This
  app never keeps a mailbox or ETS table as a second queue, and never writes job
  state directly — it only calls the narrow `SECURITY DEFINER` transition
  functions granted to the worker login.

  Fencing: every privileged call carries the pair `{lease_generation, token}`.
  The generation is monotonic per job (the database increments it on each claim);
  the token is a fresh 32-byte secret kept only in this process's memory. The
  database stores the token's SHA-256 hex, so a lease value that leaked from a
  database dump cannot be replayed. A call from a previous generation is refused
  with `AgentosWorker.Queue.StaleLeaseError` and changes nothing.

  Outbox: events are written by the database in the same transaction as the
  state change and mirrored into `uap.job_outbox`. Delivery happens afterwards
  (`AgentosWorker.Queue.OutboxRelay`) and is at-least-once, so consumers key on
  `event_id`.
  """

  @enforce_keys [:organization_id, :job_id, :generation, :token]
  defstruct [:organization_id, :job_id, :generation, :token, :expires_at]

  @type t :: %__MODULE__{
          organization_id: String.t(),
          job_id: String.t(),
          generation: pos_integer(),
          token: String.t(),
          expires_at: non_neg_integer() | nil
        }

  @token_pattern ~r/^[A-Za-z0-9_-]{43}$/
  @max_id_bytes 200

  @doc "Returns a new 32-byte lease token as the 43-character base64url string the queue stores."
  @spec new_token() :: String.t()
  def new_token, do: Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

  @doc """
  Returns the SHA-256 hex digest stored in `uap.task_jobs.lease_token_hash`.

  Raises for anything that is not a valid lease token: callers must never
  silently hash an arbitrary string into a credential.
  """
  @spec token_hash(String.t()) :: String.t()
  def token_hash(token) do
    case validate_token(token) do
      :ok -> Base.encode16(:crypto.hash(:sha256, token), case: :lower)
      :error -> raise ArgumentError, "lease token must be 43 base64url characters"
    end
  end

  @doc "Builds a lease value object; returns `{:error, :invalid_lease}` instead of raising."
  @spec lease(String.t(), String.t(), integer(), String.t(), integer() | nil) ::
          {:ok, t()} | {:error, :invalid_lease}
  def lease(organization_id, job_id, generation, token, expires_at \\ nil) do
    validate(%__MODULE__{
      organization_id: organization_id,
      job_id: job_id,
      generation: generation,
      token: token,
      expires_at: expires_at
    })
  end

  @doc "Validates a lease value object (again) before it is sent to a privileged transition."
  @spec validate(t() | term()) :: {:ok, t()} | {:error, :invalid_lease}
  def validate(%__MODULE__{} = lease) do
    cond do
      not valid_id?(lease.organization_id) -> {:error, :invalid_lease}
      not valid_id?(lease.job_id) -> {:error, :invalid_lease}
      not (is_integer(lease.generation) and lease.generation > 0) -> {:error, :invalid_lease}
      validate_token(lease.token) == :error -> {:error, :invalid_lease}
      not valid_expiry?(lease.expires_at) -> {:error, :invalid_lease}
      true -> {:ok, lease}
    end
  end

  def validate(_other), do: {:error, :invalid_lease}

  defp validate_token(token) when is_binary(token) do
    if Regex.match?(@token_pattern, token), do: :ok, else: :error
  end

  defp validate_token(_token), do: :error

  defp valid_id?(value) when is_binary(value) do
    bytes = byte_size(value)
    bytes in 1..@max_id_bytes and not String.contains?(value, <<0>>)
  end

  defp valid_id?(_value), do: false

  defp valid_expiry?(nil), do: true
  defp valid_expiry?(value), do: is_integer(value) and value >= 0
end

defmodule AgentosWorker.Queue.StaleLeaseError do
  @moduledoc """
  The presented `{generation, token}` is not the lease that currently owns the
  job (superseded, expired, released, or never issued). The transition was
  refused and no state changed.
  """
  defexception [:message, :organization_id, :job_id, :generation]

  @impl true
  def exception(opts) do
    %__MODULE__{
      message: "lease is no longer current for job #{inspect(Keyword.get(opts, :job_id))}",
      organization_id: Keyword.get(opts, :organization_id),
      job_id: Keyword.get(opts, :job_id),
      generation: Keyword.get(opts, :generation)
    }
  end
end

defmodule AgentosWorker.Queue.InvalidInputError do
  @moduledoc "The transition function rejected its arguments before touching any row."
  defexception [:message]

  @impl true
  def exception(opts),
    do: %__MODULE__{message: Keyword.get(opts, :message, "invalid queue input")}
end

defmodule AgentosWorker.Queue.TransitionError do
  @moduledoc "The transition is not allowed in the job's current state (for example, cancelled work)."
  defexception [:message]

  @impl true
  def exception(opts), do: %__MODULE__{message: Keyword.get(opts, :message, "transition refused")}
end
