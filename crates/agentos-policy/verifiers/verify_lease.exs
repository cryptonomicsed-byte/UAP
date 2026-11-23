# Portable lease verifier (V6-05-09) — Elixir reference implementation.
#
# Usage: elixir verify_lease.exs <fixture-dir>
#
# Fourth independent implementation of the same contract. No Mix project and no hex
# dependency on purpose: a verifier that needs a build step is a verifier that gets
# skipped. JSON is parsed by a small strict parser for exactly this schema — unknown
# keys, escapes, floats and negative numbers are all rejected, because a lease that
# needs them is not a lease.
#
# Run from the repository root or give an absolute fixture path.

defmodule Uap.LeaseVerifier do
  @domain "uap-lease/1"
  @keys ~w(v lease_id task_id tenant sid role_digest grant_id epoch issued_at_ms expires_at_ms revocation nonce)
  @rev_keys ~w(list version)

  def main([dir]) do
    run(dir)
  end

  def main(_) do
    IO.puts(:stderr, "usage: elixir verify_lease.exs <fixture-dir>")
    System.halt(2)
  end

  defp run(dir) do
    name = Path.basename(dir)

    case File.read(Path.join(dir, "expect.txt")) do
      {:error, reason} ->
        IO.puts("verify-lease #{name}: error=expect.txt:#{reason}")
        System.halt(1)

      {:ok, raw} ->
        expect = String.trim(raw)
        {verified, reason, digest} = verify(dir)
        got = if verified, do: "valid", else: "invalid"
        sha = digest || "-"

        IO.puts(
          "verify-lease #{name}: expect=#{expect} got=#{got} sha256=#{sha} reason=#{reason}"
        )

        if got == expect, do: System.halt(0), else: System.halt(1)
    end
  end

  defp verify(dir) do
    case File.read(Path.join(dir, "fields.json")) do
      {:error, reason} ->
        {false, "fields.json: #{reason}", nil}

      {:ok, raw} ->
        case parse_json(raw) do
          {:error, reason} ->
            {false, "schema: #{reason}", nil}

          {:ok, fields} ->
            case validate(fields) do
              {:error, reason} -> {false, "schema: #{reason}", nil}
              :ok -> check_crypto(dir, fields)
            end
        end
    end
  end

  defp check_crypto(dir, fields) do
    body = canonical(fields)
    digest = :crypto.hash(:sha256, body) |> Base.encode16(case: :lower)

    with {:ok, want} <- File.read(Path.join(dir, "canonical.sha256")),
         {:ok, sig_hex} <- File.read(Path.join(dir, "sig.hex")),
         {:ok, pub_hex} <- File.read(Path.join(dir, "issuer.pub.hex")) do
      if String.trim(want) != digest do
        {false, "canonical bytes differ (built #{digest}, expected #{String.trim(want)})", digest}
      else
        verify_signature(body, String.trim(sig_hex), String.trim(pub_hex), digest)
      end
    else
      {:error, reason} -> {false, "fixture file: #{reason}", digest}
    end
  end

  defp verify_signature(body, sig_hex, pub_hex, digest) do
    with {:ok, sig} <- decode_hex(sig_hex),
         {:ok, pub} <- decode_hex(pub_hex) do
      cond do
        byte_size(sig) != 64 ->
          {false, "signature is not 64 bytes", digest}

        byte_size(pub) != 32 ->
          {false, "public key is not 32 bytes", digest}

        :crypto.verify(:eddsa, :none, @domain <> "\n" <> body, sig, [pub, :ed25519]) ->
          {true, "ok", digest}

        true ->
          {false, "signature does not verify", digest}
      end
    else
      :error -> {false, "signature or key is not lowercase hex", digest}
    end
  end

  defp decode_hex(hex) do
    case Base.decode16(hex, case: :lower) do
      {:ok, bin} -> {:ok, bin}
      :error -> :error
    end
  end

  defp canonical(f) do
    rev = f["revocation"]

    "{" <>
      "\"v\":\"#{f["v"]}\"," <>
      "\"lease_id\":\"#{f["lease_id"]}\"," <>
      "\"task_id\":\"#{f["task_id"]}\"," <>
      "\"tenant\":\"#{f["tenant"]}\"," <>
      "\"sid\":\"#{f["sid"]}\"," <>
      "\"role_digest\":\"#{f["role_digest"]}\"," <>
      "\"grant_id\":\"#{f["grant_id"]}\"," <>
      "\"epoch\":#{f["epoch"]}," <>
      "\"issued_at_ms\":#{f["issued_at_ms"]}," <>
      "\"expires_at_ms\":#{f["expires_at_ms"]}," <>
      "\"revocation\":{\"list\":\"#{rev["list"]}\",\"version\":#{rev["version"]}}," <>
      "\"nonce\":\"#{f["nonce"]}\"}"
  end

  # ------------------------------------------------------------------ validation

  defp validate(fields) when is_map(fields) do
    cond do
      Enum.sort(Map.keys(fields)) != Enum.sort(@keys) ->
        {:error, "keys are #{inspect(Map.keys(fields))}"}

      fields["v"] != @domain ->
        {:error, "v is #{inspect(fields["v"])}"}

      not is_map(fields["revocation"]) ->
        {:error, "revocation is not an object"}

      Enum.sort(Map.keys(fields["revocation"])) != Enum.sort(@rev_keys) ->
        {:error, "revocation keys are #{inspect(Map.keys(fields["revocation"]))}"}

      true ->
        validate_fields(fields)
    end
  end

  defp validate(fields), do: {:error, "document is not an object: #{inspect(fields)}"}

  defp validate_fields(f) do
    ids = ["lease_id", "task_id", "tenant", "sid", "grant_id", f["revocation"]["list"]]
    bad_id = Enum.find(ids, fn v -> not safe_id?(v) end)
    hexes = [f["role_digest"], f["nonce"]]
    nums = [f["epoch"], f["issued_at_ms"], f["expires_at_ms"], f["revocation"]["version"]]

    cond do
      bad_id != nil -> {:error, "identifier outside the safe charset: #{inspect(bad_id)}"}
      Enum.any?(hexes, &(not hex64?(&1))) -> {:error, "digest is not 64 lowercase hex"}
      Enum.any?(nums, &(not uint?(&1))) -> {:error, "a counter is not a non-negative integer"}
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

  # ------------------------------------------------------------ strict JSON parser

  defp parse_json(bin) do
    {value, rest} = value(skip(bin))

    case skip(rest) do
      "" -> {:ok, value}
      other -> {:error, "trailing data: #{inspect(other)}"}
    end
  rescue
    e in RuntimeError -> {:error, Exception.message(e)}
  end

  defp value(<<"{", rest::binary>>), do: object(skip(rest), %{})
  defp value(<<"\"", rest::binary>>), do: string(rest, [])
  defp value(<<"true", _::binary>>), do: raise "booleans are not part of the lease schema"
  defp value(<<"false", _::binary>>), do: raise "booleans are not part of the lease schema"
  defp value(<<"null", _::binary>>), do: raise "null is not part of the lease schema"
  defp value(bin), do: number(bin)

  defp object(<<"}", rest::binary>>, acc), do: {acc, rest}

  defp object(<<"\"", rest::binary>>, acc) do
    {key, after_key} = string(rest, [])

    after_colon =
      case skip(after_key) do
        <<":", r::binary>> -> r
        _ -> raise "expected ':' after key #{inspect(key)}"
      end

    {val, after_val} = value(skip(after_colon))
    acc = Map.put(acc, key, val)

    case skip(after_val) do
      <<",", r::binary>> -> object(skip(r), acc)
      <<"}", r::binary>> -> {acc, r}
      _ -> raise "expected ',' or '}' after #{inspect(key)}"
    end
  end

  defp object(bin, _acc), do: raise("expected a quoted key, got #{inspect(bin)}")

  defp string(<<"\"", rest::binary>>, acc) do
    {acc |> Enum.reverse() |> List.to_string(), rest}
  end

  defp string(<<"\\", _::binary>>, _acc) do
    raise "escaped characters are not allowed by the lease schema"
  end

  defp string(<<c::utf8, rest::binary>>, acc) when c >= 0x20 do
    string(rest, [c | acc])
  end

  defp string(<<c, _::binary>>, _acc), do: raise("control character 0x#{Integer.to_string(c, 16)} in string")
  defp string(<<>>, _acc), do: raise("unterminated string")

  defp number(bin) do
    case Integer.parse(bin) do
      {n, rest} when n >= 0 -> {n, rest}
      _ -> raise "expected a non-negative integer, got #{inspect(String.slice(bin, 0, 12))}"
    end
  end

  defp skip(<<c, rest::binary>>) when c in [?\s, ?\t, ?\n, ?\r], do: skip(rest)
  defp skip(bin), do: bin
end

Uap.LeaseVerifier.main(System.argv())
