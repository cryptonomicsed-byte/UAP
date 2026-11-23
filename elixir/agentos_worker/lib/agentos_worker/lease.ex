defmodule AgentosWorker.Lease do
  @moduledoc """
  Signed task lease — the `uap-lease/1` contract, verified inside the worker.

  This is deliberately the *same* contract the Rust kernel issues and the four
  portable verifiers check (`crates/agentos-policy/verifiers/`): canonical bytes,
  domain-separated Ed25519 signature, strict schema. The worker never trusts a
  coordinator's claim that a lease is valid — it re-derives the canonical bytes
  and re-verifies the signature itself.

  The schema is strict on purpose: unknown keys, escapes, floats, booleans and
  negative numbers are rejected rather than coerced. Two leases with identical
  fields are still distinct because the schema carries a random nonce.
  """

  @domain "uap-lease/1"

  @keys ~w(lease_id task_id tenant sid role_digest grant_id epoch issued_at_ms
           expires_at_ms revocation nonce v)
  @rev_keys ~w(list version)
  @max_lease_ms 24 * 60 * 60 * 1000

  @type fields :: %{required(String.t()) => term()}

  @doc """
  Validates schema and canonical-verifies `fields` against `sig_hex` / `pub_hex`.

  Returns `{:ok, canonical_bytes, digest_hex}`, or `{:error, :lease_schema}` /
  `{:error, :lease_signature}`.
  """
  @spec verify(fields(), String.t(), String.t()) ::
          {:ok, binary(), String.t()} | {:error, :lease_schema | :lease_signature}
  def verify(fields, sig_hex, pub_hex) when is_map(fields) do
    with :ok <- validate(fields) do
      body = canonical(fields)
      digest = :crypto.hash(:sha256, body) |> Base.encode16(case: :lower)

      with {:ok, sig} <- decode_hex(sig_hex),
           {:ok, pub} <- decode_hex(pub_hex),
           true <- byte_size(sig) == 64 and byte_size(pub) == 32,
           true <- :crypto.verify(:eddsa, :none, @domain <> "\n" <> body, sig, [pub, :ed25519]) do
        {:ok, body, digest}
      else
        _ -> {:error, :lease_signature}
      end
    end
  end

  def verify(_fields, _sig, _pub), do: {:error, :lease_schema}

  @doc "Canonical signing bytes for a schema-valid lease (caller must validate first)."
  @spec canonical(fields()) :: binary()
  def canonical(f) do
    rev = f["revocation"]

    "{" <>
      ~s("v":"#{f["v"]}",) <>
      ~s("lease_id":"#{f["lease_id"]}",) <>
      ~s("task_id":"#{f["task_id"]}",) <>
      ~s("tenant":"#{f["tenant"]}",) <>
      ~s("sid":"#{f["sid"]}",) <>
      ~s("role_digest":"#{f["role_digest"]}",) <>
      ~s("grant_id":"#{f["grant_id"]}",) <>
      ~s("epoch":#{f["epoch"]},) <>
      ~s("issued_at_ms":#{f["issued_at_ms"]},) <>
      ~s("expires_at_ms":#{f["expires_at_ms"]},) <>
      ~s("revocation":{"list":"#{rev["list"]}","version":#{rev["version"]}},) <>
      ~s("nonce":"#{f["nonce"]}") <>
      "}"
  end

  @doc """
  Internal consistency of a schema-valid lease: epoch >= 1, a forward window, and
  at most `MAX_LEASE_MS` of life. Anything else is `{:error, :lease_epoch}`.
  """
  @spec window(fields()) :: :ok | {:error, :lease_epoch}
  def window(f) do
    issued = f["issued_at_ms"]
    expires = f["expires_at_ms"]

    cond do
      not is_integer(f["epoch"]) or f["epoch"] < 1 -> {:error, :lease_epoch}
      not is_integer(expires) or not is_integer(issued) -> {:error, :lease_epoch}
      expires <= issued -> {:error, :lease_epoch}
      expires - issued > @max_lease_ms -> {:error, :lease_epoch}
      true -> :ok
    end
  end

  # ---------------------------------------------------------------- validation

  defp validate(f) when is_map(f) do
    cond do
      Enum.sort(Map.keys(f)) != Enum.sort(@keys) -> {:error, :lease_schema}
      f["v"] != @domain -> {:error, :lease_schema}
      not is_map(f["revocation"]) -> {:error, :lease_schema}
      Enum.sort(Map.keys(f["revocation"])) != Enum.sort(@rev_keys) -> {:error, :lease_schema}
      true -> validate_fields(f)
    end
  end

  defp validate(_f), do: {:error, :lease_schema}

  defp validate_fields(f) do
    ids = ["lease_id", "task_id", "tenant", "sid", "grant_id", f["revocation"]["list"]]
    hexes = [f["role_digest"], f["nonce"]]
    nums = [f["epoch"], f["issued_at_ms"], f["expires_at_ms"], f["revocation"]["version"]]

    cond do
      Enum.any?(ids, &(not safe_id?(&1))) -> {:error, :lease_schema}
      Enum.any?(hexes, &(not hex64?(&1))) -> {:error, :lease_schema}
      Enum.any?(nums, &(not uint?(&1))) -> {:error, :lease_schema}
      true -> :ok
    end
  end

  defp safe_id?(s) when is_binary(s) and byte_size(s) > 0 do
    Enum.all?(String.to_charlist(s), fn c -> c >= 0x21 and c <= 0x7E and c != ?" and c != ?\\ end)
  end

  defp safe_id?(_), do: false

  defp hex64?(s) when is_binary(s), do: String.match?(s, ~r/^[0-9a-f]{64}$/)
  defp hex64?(_), do: false

  defp uint?(n), do: is_integer(n) and n >= 0

  defp decode_hex(hex) when is_binary(hex), do: Base.decode16(hex, case: :lower)
  defp decode_hex(_), do: :error
end
