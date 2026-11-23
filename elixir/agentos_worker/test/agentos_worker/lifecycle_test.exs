defmodule AgentosWorker.LifecycleTest do
  @moduledoc """
  Reconciliation policy (V6-06-07), pure and clock-free.

  The queue state machine in PostgreSQL already decides what a *crashed* lease
  becomes (`uap.claim_task_job` recovery loop). This module decides what a
  *live* worker asks for when it stops: prove the effect, reconcile it, or
  retry — and it may never ask for a retry it cannot justify.
  """
  use ExUnit.Case, async: true

  alias AgentosWorker.Lifecycle

  defp report(overrides) do
    Map.merge(
      %{
        retry_safety: :idempotent,
        effect: :none,
        cancel_requested: false,
        number: 1,
        max: 3,
        retry_delay_ms: 1_000
      },
      Map.new(overrides)
    )
  end

  test "a proven effect settles as succeeded, with no retry" do
    assert {:ok, plan} = Lifecycle.settlement(report(effect: :applied))
    assert plan.outcome == "succeeded"
    assert plan.retry_in_ms == nil
    assert plan.error == nil
  end

  test "an uncertain effect on reconcile-only work is settled incomplete and never retried" do
    assert {:ok, plan} =
             Lifecycle.settlement(report(retry_safety: :reconcile_only, effect: :uncertain))

    assert plan.outcome == "incomplete"
    assert plan.retry_in_ms == nil
    assert plan.error.code == "uncertain_effect"
    assert plan.reason == :uncertain_effect
  end

  test "an uncertain effect on idempotent work retries only with the uncertainty recorded" do
    assert {:ok, plan} = Lifecycle.settlement(report(effect: :uncertain))

    assert plan.outcome == "failed"
    assert plan.retry_in_ms == 1_000
    assert plan.error.code == "uncertain_effect_retry"
    assert plan.reason == :uncertain_effect_retry
  end

  test "exhausted attempts ask for no retry, so the queue can dead-letter" do
    assert {:ok, plan} = Lifecycle.settlement(report(number: 3, max: 3, effect: :none))
    assert plan.outcome == "failed"
    assert plan.retry_in_ms == nil
    assert plan.reason == :attempts_exhausted

    assert {:ok, uncertain} = Lifecycle.settlement(report(number: 3, max: 3, effect: :uncertain))

    assert uncertain.outcome == "failed"
    assert uncertain.retry_in_ms == nil
    assert uncertain.error.code == "uncertain_effect"
  end

  test "reconcile-only work is never re-queued, even when no effect started" do
    assert {:ok, plan} = Lifecycle.settlement(report(retry_safety: :reconcile_only))

    assert plan.outcome == "incomplete"
    assert plan.retry_in_ms == nil
    assert plan.error.code == "reconcile_only"
  end

  test "a cancellation settles as cancelled only when the effect never landed" do
    assert {:ok, plan} = Lifecycle.settlement(report(cancel_requested: true))
    assert plan.outcome == "cancelled"
    assert plan.retry_in_ms == nil
  end

  test "a cancellation that arrives after the effect landed is an incomplete, not a cancellation" do
    assert {:ok, plan} = Lifecycle.settlement(report(cancel_requested: true, effect: :applied))

    assert plan.outcome == "incomplete"
    assert plan.reason == :effect_applied_after_cancel
    assert plan.error.code == "cancelled_after_effect"
    assert plan.retry_in_ms == nil
  end

  test "a plain failure retries with exponential backoff capped at one hour" do
    assert {:ok, %{retry_in_ms: 1_000}} = Lifecycle.settlement(report(number: 1))
    assert {:ok, %{retry_in_ms: 2_000}} = Lifecycle.settlement(report(number: 2))
    assert {:ok, %{retry_in_ms: 4_000}} = Lifecycle.settlement(report(number: 3, max: 5))

    assert {:ok, %{retry_in_ms: 3_600_000}} =
             Lifecycle.settlement(report(number: 9, max: 20, retry_delay_ms: 600_000))
  end

  test "refuses reports that would let a caller weaken the retry contract" do
    for bad <- [
          report(retry_safety: :whatever),
          report(effect: :maybe),
          report(cancel_requested: "yes"),
          report(number: 0),
          report(number: 4, max: 3),
          report(max: 0),
          report(retry_delay_ms: -1),
          report(retry_delay_ms: 3_600_001),
          %{},
          :not_a_report
        ] do
      assert {:error, :invalid_report} = Lifecycle.settlement(bad)
    end
  end

  test "crash recovery waits for the lease to expire; the process that held the token is gone" do
    assert {:wait, 45_000} = Lifecycle.crash_recovery(1_045_000, 1_000_000)
    assert :reclaimable = Lifecycle.crash_recovery(1_000_000, 1_000_000)
    assert :reclaimable = Lifecycle.crash_recovery(999_000, 1_000_000)
    assert {:error, :invalid_lease_window} = Lifecycle.crash_recovery(-1, 0)
  end

  test "cancel transitions are idempotent while running and refused once finished" do
    assert {:ok, :cancelling} = Lifecycle.cancel_transition(:running)
    assert {:ok, :cancelling} = Lifecycle.cancel_transition(:cancelling)

    for done <- [:succeeded, :failed, :incomplete, :cancelled, :expired] do
      assert {:error, :already_finished} = Lifecycle.cancel_transition(done)
    end

    assert {:error, :invalid_status} = Lifecycle.cancel_transition("running")
    assert {:error, :invalid_status} = Lifecycle.cancel_transition(nil)
  end
end
