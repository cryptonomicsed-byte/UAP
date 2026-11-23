defmodule AgentosWorker.Lifecycle do
  @moduledoc """
  Reconciliation policy for a live task attempt (V6-06-07).

  Two authorities decide what happens to work that stops:

    * `uap.claim_task_job` owns **crash** recovery. An expired lease is turned
      into `queued` (idempotent attempt left), `incomplete` (cancelling,
      `reconcile_only`, or a consumed approval) or `dead_letter` (attempt
      ceiling) inside the database, in the same transaction that would hand the
      job out again. A crashed worker holds no token, so it cannot settle
      anything itself; this module only states how long the lease must run out
      first (`crash_recovery/2`).
    * This module owns what the **living** worker asks for when it stops:
      prove the effect and settle `succeeded`, reconcile `incomplete`, honour a
      cancellation, or retry. It never asks for a retry it cannot justify:
      `reconcile_only` work is never re-queued, an uncertain effect on such work
      is settled `incomplete` with the uncertainty recorded, and no plan may
      exceed the attempt ceiling.

  The plan is data, not a side effect: `settlement/1` computes it and
  `AgentosWorker.TaskWorker.finish/3` hands it to the queue. The database
  validates it again (`uap.settle_task_job` refuses `cancelled` without a
  recorded cancellation request, and refuses `succeeded` over a pending
  approval), so a bug here cannot silently overwrite the queue's decision.
  """

  @type retry_safety :: :idempotent | :reconcile_only
  @type effect :: :none | :applied | :uncertain

  @type plan :: %{
          outcome: String.t(),
          retry_in_ms: non_neg_integer() | nil,
          error: %{code: String.t(), detail: String.t()} | nil,
          reason: atom()
        }

  @retry_safeties %{"idempotent" => :idempotent, "reconcile_only" => :reconcile_only}
  @effects %{"none" => :none, "applied" => :applied, "uncertain" => :uncertain}
  @finished [:succeeded, :failed, :incomplete, :cancelled, :expired, :dead_letter]
  @max_delay_ms 3_600_000
  @max_attempts 100

  @doc """
  Computes the settlement plan for one attempt report.

  Report keys (atom or string): `retry_safety`, `effect`, `cancel_requested`,
  `number` (this attempt), `max` (attempt ceiling), `retry_delay_ms` (base
  backoff). Returns `{:error, :invalid_report}` rather than guessing a default.
  """
  @spec settlement(map() | term()) :: {:ok, plan()} | {:error, :invalid_report}
  def settlement(report) when is_map(report) do
    with {:ok, normalized} <- normalize(report), do: {:ok, decide(normalized)}
  end

  def settlement(_report), do: {:error, :invalid_report}

  @doc """
  How long a crashed attempt must wait before the queue may reclaim it.

  A process that died took its lease token with it, so only the database can
  reconcile the job — and only after `lease_expires_at` has passed.
  """
  @spec crash_recovery(integer(), integer()) ::
          {:wait, pos_integer()} | :reclaimable | {:error, :invalid_lease_window}
  def crash_recovery(lease_expires_at_ms, now_ms)
      when is_integer(lease_expires_at_ms) and is_integer(now_ms) and lease_expires_at_ms >= 0 do
    case lease_expires_at_ms - now_ms do
      remaining when remaining > 0 -> {:wait, remaining}
      _elapsed -> :reclaimable
    end
  end

  def crash_recovery(_lease_expires_at_ms, _now_ms), do: {:error, :invalid_lease_window}

  @doc "Lifecycle transition for a cancellation signal against a live worker."
  @spec cancel_transition(atom() | term()) ::
          {:ok, :cancelling} | {:error, :already_finished} | {:error, :invalid_status}
  def cancel_transition(status) when status in [:running, :cancelling], do: {:ok, :cancelling}
  def cancel_transition(status) when status in @finished, do: {:error, :already_finished}
  def cancel_transition(_status), do: {:error, :invalid_status}

  # ------------------------------------------------------------------- decisions

  defp decide(%{effect: :applied, cancel_requested: true}) do
    plan(
      "incomplete",
      nil,
      error(
        "cancelled_after_effect",
        "the effect landed before the cancellation was acknowledged"
      ),
      :effect_applied_after_cancel
    )
  end

  defp decide(%{effect: :applied}), do: plan("succeeded", nil, nil, :effect_applied)

  defp decide(%{effect: :uncertain, retry_safety: :reconcile_only}) do
    plan(
      "incomplete",
      nil,
      error("uncertain_effect", "non-idempotent effect may have landed; reconciliation required"),
      :uncertain_effect
    )
  end

  defp decide(%{effect: :uncertain, number: number, max: max}) when number >= max do
    plan(
      "failed",
      nil,
      error("uncertain_effect", "attempt ceiling reached with an unproven effect"),
      :uncertain_effect
    )
  end

  defp decide(%{effect: :uncertain} = report) do
    plan(
      "failed",
      backoff(report),
      error(
        "uncertain_effect_retry",
        "effect unproven; retried only because the tool is declared idempotent"
      ),
      :uncertain_effect_retry
    )
  end

  defp decide(%{cancel_requested: true}), do: plan("cancelled", nil, nil, :cancel_requested)

  defp decide(%{retry_safety: :reconcile_only}) do
    plan(
      "incomplete",
      nil,
      error("reconcile_only", "work is not safe to repeat; operator reconciliation required"),
      :reconcile_only
    )
  end

  defp decide(%{number: number, max: max}) when number >= max do
    plan(
      "failed",
      nil,
      error("attempts_exhausted", "attempt ceiling reached"),
      :attempts_exhausted
    )
  end

  defp decide(report) do
    plan("failed", backoff(report), nil, :retryable_failure)
  end

  # ------------------------------------------------------------------ internals

  defp plan(outcome, retry_in_ms, error, reason) do
    %{outcome: outcome, retry_in_ms: retry_in_ms, error: error, reason: reason}
  end

  defp error(code, detail), do: %{code: code, detail: detail}

  defp backoff(%{number: number, retry_delay_ms: delay}) do
    min(delay * Integer.pow(2, number - 1), @max_delay_ms)
  end

  defp normalize(report) do
    with {:ok, retry_safety} <- normalize_retry_safety(fetch(report, :retry_safety)),
         {:ok, effect} <- normalize_effect(fetch(report, :effect)),
         cancel when is_boolean(cancel) <- fetch(report, :cancel_requested),
         number when is_integer(number) and number in 1..@max_attempts <- fetch(report, :number),
         max when is_integer(max) and max in 1..@max_attempts <- fetch(report, :max),
         true <- number <= max,
         delay
         when is_integer(delay) and delay >= 0 and delay <= @max_delay_ms <-
           fetch(report, :retry_delay_ms) do
      {:ok,
       %{
         retry_safety: retry_safety,
         effect: effect,
         cancel_requested: cancel,
         number: number,
         max: max,
         retry_delay_ms: delay
       }}
    else
      _other -> {:error, :invalid_report}
    end
  end

  defp normalize_retry_safety(value) when is_atom(value) do
    if value in [:idempotent, :reconcile_only], do: {:ok, value}, else: :error
  end

  defp normalize_retry_safety(value) when is_binary(value),
    do: Map.fetch(@retry_safeties, value)

  defp normalize_retry_safety(_value), do: :error

  defp normalize_effect(value) when is_atom(value) do
    if value in [:none, :applied, :uncertain], do: {:ok, value}, else: :error
  end

  defp normalize_effect(value) when is_binary(value), do: Map.fetch(@effects, value)

  defp normalize_effect(_value), do: :error

  defp fetch(report, key) do
    case Map.fetch(report, key) do
      {:ok, value} -> value
      :error -> Map.get(report, Atom.to_string(key))
    end
  end
end
