defmodule AgentosWorker.TaskWorker do
  @moduledoc """
  Per-task GenServer: one task, one SID, one immutable role+skill digest, one
  signed lease (V6-06-02).

  Startup is all-or-nothing. Every check runs against the *inputs*, never against
  a coordinator's assertion, and the first failure returns a stable reason code
  (see `docs/architecture/WORKER-BINDING.md`). A worker that cannot prove its
  binding does not exist — `start_link/1` returns `{:error, reason}`.

  The binding is captured once in `init/1` and is never rewritten; `rebind/2`
  exists to prove that (it errors and changes nothing). The lease expiry is armed
  as a timer so a worker cannot outlive the credential it was started with. The
  process is named through `AgentosWorker.Registry` under `{:task, task_id}`, so
  the registry — not a mailbox — refuses a second worker for the same task.

  Lifecycle (V6-06-07): the worker records what it knows about the side effect
  (`report_effect/2`), acknowledges a graceful cancel (`cancel/1`), and settles
  through `AgentosWorker.Lifecycle` when it stops (`finish/3`). It never asks for
  a retry it cannot justify, and it stops only after the queue accepted the
  settlement — a refused settlement leaves the worker running with its lease.
  """

  use GenServer

  require Logger

  alias AgentosWorker.{Lifecycle, Registry}

  @type spec :: %{
          required(:task) => %{
            required(:task_id) => String.t(),
            required(:tenant) => String.t(),
            required(:sid) => String.t(),
            required(:role_digest) => String.t(),
            required(:skill_digest) => String.t()
          },
          required(:lease) => map(),
          required(:signature) => %{
            required(:sig_hex) => String.t(),
            required(:issuer_pub_hex) => String.t()
          },
          optional(:clock) => fun(),
          optional(:settle) => (map(), map() -> {:ok, map()} | {:error, term()})
        }

  @type attempt :: %{
          required(:retry_safety) => :idempotent | :reconcile_only,
          required(:number) => pos_integer(),
          required(:max) => pos_integer(),
          required(:retry_delay_ms) => non_neg_integer()
        }

  @sid_re ~r/^[a-z0-9][a-z0-9._:-]{2,127}$/
  @digest_re ~r/^[0-9a-f]{64}$/
  @task_keys [:task_id, :tenant, :sid, :role_digest, :skill_digest]

  # ---------------------------------------------------------------- public API

  @doc """
  Starts a worker for exactly one task, registered under `{:task, task_id}`.

  Returns `{:error, reason}` if any binding check fails, and
  `{:error, {:already_started, pid}}` if another worker already holds the task.
  """
  @spec start_link(spec()) :: GenServer.on_start()
  def start_link(%{task: %{task_id: task_id}} = spec) when is_binary(task_id) do
    GenServer.start_link(__MODULE__, spec, name: Registry.via({:task, task_id}))
  end

  def start_link(_spec), do: {:error, :invalid_task}

  @doc "Read-only binding snapshot captured at startup."
  @spec binding(GenServer.server()) :: {:ok, map()}
  def binding(server), do: GenServer.call(server, :binding)

  @doc "Truthful worker state for operator surfaces."
  @spec status(GenServer.server()) :: {:ok, map()}
  def status(server), do: GenServer.call(server, :status)

  @doc "Attempted identity change. Always errors: the binding is immutable."
  @spec rebind(GenServer.server(), String.t()) :: {:error, :immutable_binding}
  def rebind(server, _new_sid), do: GenServer.call(server, :rebind)

  @doc """
  Graceful cancellation: stops accepting new effects and flags the attempt so
  the next stop is settled as `cancelled` (or reconciled, if the effect landed
  first). Idempotent while the worker is live; a finished worker is refused.

  The operator's cancellation must land in `uap.request_task_job_cancellation`;
  `uap.settle_task_job` refuses `cancelled` without that row.
  """
  @spec cancel(GenServer.server()) ::
          {:ok, :cancelling} | {:error, :already_finished | :invalid_status}
  def cancel(server), do: GenServer.call(server, :cancel)

  @doc "Observed effect state: `:none`, `:applied` or `:uncertain`."
  @spec effect(GenServer.server()) :: {:ok, Lifecycle.effect()}
  def effect(server), do: GenServer.call(server, :effect)

  @doc """
  Records what is known about the side effect. Reports only move forward:
  `:none` may become `:applied` or `:uncertain`, `:uncertain` may still be
  upgraded to `:applied` when proof arrives, and proof is never downgraded.
  """
  @spec report_effect(GenServer.server(), atom()) ::
          {:ok, Lifecycle.effect()}
          | {:error, :effect_already_applied | :effect_already_reported | :invalid_effect}
  def report_effect(server, reported), do: GenServer.call(server, {:report_effect, reported})

  @doc """
  Ends the attempt: computes the reconciliation plan (`AgentosWorker.Lifecycle`)
  from the observed effect state and the attempt report, hands it to the wired
  settlement channel (`:settle` in the spec), and stops the worker only after
  the queue accepted the settlement.

  A refusal (`{:error, reason}`) leaves the worker running with its lease; a
  worker with no settlement channel refuses with `:settlement_not_wired` rather
  than stopping silently.
  """
  @spec finish(GenServer.server(), attempt() | map(), map()) ::
          {:ok, Lifecycle.plan(), map()}
          | {:error, :invalid_report | :settlement_not_wired | term()}
  def finish(server, attempt, payload \\ %{}),
    do: GenServer.call(server, {:finish, attempt, payload})

  # ------------------------------------------------------------------ callbacks

  @impl true
  def init(spec) do
    case bind(spec) do
      {:ok, binding, lease} ->
        clock = clock(spec)
        arm_expiry(binding.lease_expires_at_ms, clock)

        {:ok,
         %{
           binding: binding,
           lease: lease,
           clock: clock,
           status: :running,
           effect: :none,
           cancel_requested: false,
           settle: Map.get(spec, :settle)
         }}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def handle_call(:binding, _from, state), do: {:reply, {:ok, state.binding}, state}

  def handle_call(:status, _from, state) do
    status =
      state.binding
      |> Map.put(:status, state.status)
      |> Map.put(:effect, state.effect)
      |> Map.put(:cancel_requested, state.cancel_requested)

    {:reply, {:ok, status}, state}
  end

  def handle_call(:rebind, _from, state), do: {:reply, {:error, :immutable_binding}, state}

  def handle_call(:cancel, _from, state) do
    case Lifecycle.cancel_transition(state.status) do
      {:ok, :cancelling} ->
        Logger.info("task worker cancellation acknowledged",
          task_id: state.binding.task_id,
          sid: state.binding.sid
        )

        {:reply, {:ok, :cancelling}, %{state | status: :cancelling, cancel_requested: true}}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call(:effect, _from, state), do: {:reply, {:ok, state.effect}, state}

  def handle_call({:report_effect, reported}, _from, state) do
    case advance_effect(state.effect, reported) do
      {:ok, effect} -> {:reply, {:ok, effect}, %{state | effect: effect}}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:finish, attempt, payload}, _from, state) do
    report =
      attempt
      |> Map.take([:retry_safety, :number, :max, :retry_delay_ms])
      |> Map.merge(%{effect: state.effect, cancel_requested: state.cancel_requested})

    with {:ok, plan} <- Lifecycle.settlement(report) do
      case state.settle do
        fun when is_function(fun, 2) ->
          payload = %{
            result: Map.get(payload, :result),
            error: Map.get(payload, :error) || plan.error
          }

          case fun.(plan, payload) do
            {:ok, job} ->
              {:stop, {:shutdown, {:settled, plan.outcome}}, {:ok, plan, job},
               %{state | status: :settled}}

            {:error, reason} ->
              {:reply, {:error, reason}, state}
          end

        _not_wired ->
          {:reply, {:error, :settlement_not_wired}, state}
      end
    else
      {:error, :invalid_report} -> {:reply, {:error, :invalid_report}, state}
    end
  end

  @impl true
  def handle_info(:lease_expiry, state) do
    if state.clock.() >= state.binding.lease_expires_at_ms do
      Logger.info("task worker lease expired",
        task_id: state.binding.task_id,
        sid: state.binding.sid
      )

      {:stop, {:shutdown, :lease_expired}, %{state | status: :expired}}
    else
      arm_expiry(state.binding.lease_expires_at_ms, state.clock)
      {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # ------------------------------------------------------------------- effects

  defp advance_effect(_current, reported) when reported not in [:none, :applied, :uncertain] do
    {:error, :invalid_effect}
  end

  defp advance_effect(:applied, :applied), do: {:ok, :applied}
  defp advance_effect(:applied, _reported), do: {:error, :effect_already_applied}
  defp advance_effect(:uncertain, :none), do: {:error, :effect_already_reported}
  defp advance_effect(:uncertain, reported), do: {:ok, reported}
  defp advance_effect(:none, reported), do: {:ok, reported}

  # ------------------------------------------------------------------ binding

  defp bind(spec) do
    task = Map.get(spec, :task)
    lease = Map.get(spec, :lease)
    sig = Map.get(spec, :signature)

    with :ok <- check_task(task),
         :ok <- check_sid(task.sid),
         :ok <- check_digest(task.role_digest),
         :ok <- check_digest(task.skill_digest),
         {:ok, _body, _digest} <- check_lease(lease, sig),
         :ok <- check_equal(lease["sid"], task.sid, :sid_mismatch),
         :ok <- check_equal(lease["tenant"], task.tenant, :tenant_mismatch),
         :ok <- check_equal(lease["task_id"], task.task_id, :task_mismatch),
         :ok <- check_equal(lease["role_digest"], task.role_digest, :role_digest_mismatch),
         :ok <- AgentosWorker.Lease.window(lease),
         now <- clock(spec).(),
         :ok <- check_time(lease, now) do
      {:ok, snapshot(task, lease, now), lease}
    end
  end

  defp check_task(task) when is_map(task) do
    if Enum.all?(@task_keys, fn k -> is_binary(task[k]) and task[k] != "" end) do
      :ok
    else
      {:error, :invalid_task}
    end
  end

  defp check_task(_), do: {:error, :invalid_task}

  defp check_sid(sid) do
    if is_binary(sid) and Regex.match?(@sid_re, sid), do: :ok, else: {:error, :invalid_sid}
  end

  defp check_digest(d) do
    if is_binary(d) and Regex.match?(@digest_re, d), do: :ok, else: {:error, :invalid_digest}
  end

  defp check_lease(lease, %{sig_hex: sig, issuer_pub_hex: pub}) do
    AgentosWorker.Lease.verify(lease, sig, pub)
  end

  defp check_lease(_lease, _sig), do: {:error, :lease_schema}

  defp check_equal(a, b, reason), do: if(a === b, do: :ok, else: {:error, reason})

  defp check_time(lease, now) do
    cond do
      now < lease["issued_at_ms"] -> {:error, :lease_not_yet_valid}
      now >= lease["expires_at_ms"] -> {:error, :lease_expired}
      true -> :ok
    end
  end

  defp snapshot(task, lease, now) do
    %{
      task_id: task.task_id,
      tenant: task.tenant,
      sid: task.sid,
      role_digest: task.role_digest,
      skill_digest: task.skill_digest,
      lease_id: lease["lease_id"],
      grant_id: lease["grant_id"],
      epoch: lease["epoch"],
      revocation: %{list: lease["revocation"]["list"], version: lease["revocation"]["version"]},
      lease_expires_at_ms: lease["expires_at_ms"],
      checked_at_ms: now
    }
  end

  defp arm_expiry(expires_at_ms, clock) do
    remaining = expires_at_ms - clock.()

    if remaining > 0,
      do: Process.send_after(self(), :lease_expiry, min(remaining, 60_000)),
      else: :ok
  end

  defp clock(spec) do
    case Map.get(spec, :clock) do
      fun when is_function(fun, 0) -> fun
      _ -> fn -> System.system_time(:millisecond) end
    end
  end

  # DynamicSupervisor child: one live worker per task, never silently restarted
  # on a dead lease — reconciliation is explicit work (M2-11).
  def child_spec(%{task: %{task_id: task_id}} = spec) when is_binary(task_id) do
    %{id: {__MODULE__, task_id}, start: {__MODULE__, :start_link, [spec]}, restart: :temporary}
  end
end
