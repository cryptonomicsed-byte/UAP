defmodule AgentosWorker.QueueLeaseTest do
  @moduledoc """
  Unit-level contract for the queue lease value object (V6-06-03).

  The lease is the only thing a task process may present to a privileged
  transition. These tests pin the two properties the database relies on: the
  generation is a positive integer and the token is the exact 43-character
  base64url string whose SHA-256 hex the queue stores.
  """
  use ExUnit.Case, async: true

  alias AgentosWorker.Queue

  test "a fresh token is 43-character base64url and hashes to the 64-hex digest the queue stores" do
    token = Queue.new_token()
    assert Regex.match?(~r/^[A-Za-z0-9_-]{43}$/, token)
    hash = Queue.token_hash(token)
    assert Regex.match?(~r/^[a-f0-9]{64}$/, hash)
    assert hash == Base.encode16(:crypto.hash(:sha256, token), case: :lower)
    refute token == Queue.new_token(), "two tokens must not collide"
  end

  test "a lease refuses a zero or negative generation, blank ids and a malformed token" do
    token = Queue.new_token()
    assert {:error, :invalid_lease} = Queue.lease("org", "job", 0, token, 1_000)
    assert {:error, :invalid_lease} = Queue.lease("org", "job", -1, token, 1_000)
    assert {:error, :invalid_lease} = Queue.lease("", "job", 1, token, 1_000)

    assert {:error, :invalid_lease} =
             Queue.lease("org", String.duplicate("j", 201), 1, token, 1_000)

    assert {:error, :invalid_lease} = Queue.lease("org", "job", 1, "not-a-token", 1_000)
    assert {:error, :invalid_lease} = Queue.lease("org", "job", 1, token, -5)

    assert {:ok, %Queue{organization_id: "org", job_id: "job", generation: 2}} =
             Queue.lease("org", "job", 2, token, 1_000)
  end

  test "the stored hash cannot be replayed as a lease token" do
    token = Queue.new_token()
    {:ok, lease} = Queue.lease("org", "job", 1, token, 1_000)
    replay = %{lease | token: Queue.token_hash(token)}
    assert {:error, :invalid_lease} = Queue.validate(replay)
  end
end
