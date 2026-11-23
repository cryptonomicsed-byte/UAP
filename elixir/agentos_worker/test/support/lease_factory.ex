defmodule AgentosWorker.LeaseFactory do
  @moduledoc false
  # Test-only minting of signed `uap-lease/1` documents. Mirrors what the Rust
  # kernel issues: the same canonical encoding, the same domain tag, the same
  # Ed25519 scheme (`uap-lease/1\n` <> canonical bytes).

  alias AgentosWorker.Lease

  @default_role_digest String.duplicate("ff", 32)
  @default_skill_digest String.duplicate("ab", 32)

  def keypair, do: :crypto.generate_key(:eddsa, :ed25519)

  def issue(overrides \\ %{}) do
    {pub, priv} = keypair()
    now = System.system_time(:millisecond)

    lease =
      Map.merge(
        %{
          "v" => "uap-lease/1",
          "lease_id" => "lease-t1",
          "task_id" => "task-t1",
          "tenant" => "acme",
          "sid" => "sid_test01",
          "role_digest" => @default_role_digest,
          "grant_id" => "grant-t1",
          "epoch" => 1,
          "issued_at_ms" => now - 1_000,
          "expires_at_ms" => now + 60_000,
          "revocation" => %{"list" => "revocations-acme", "version" => 1},
          "nonce" => String.duplicate("1a", 32)
        },
        overrides
      )

    body = Lease.canonical(lease)
    sig = :crypto.sign(:eddsa, :none, "uap-lease/1\n" <> body, [priv, :ed25519])

    %{
      lease: lease,
      signature: %{
        sig_hex: Base.encode16(sig, case: :lower),
        issuer_pub_hex: Base.encode16(pub, case: :lower)
      },
      pub: pub
    }
  end

  def task(overrides \\ %{}) do
    Map.merge(
      %{
        task_id: "task-t1",
        tenant: "acme",
        sid: "sid_test01",
        role_digest: @default_role_digest,
        skill_digest: @default_skill_digest
      },
      overrides
    )
  end

  def spec(lease_overrides \\ %{}, task_overrides \\ %{}) do
    %{lease: lease, signature: signature} = issue(lease_overrides)
    %{task: task(task_overrides), lease: lease, signature: signature}
  end
end
