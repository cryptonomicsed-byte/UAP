defmodule AgentosWorker.JSONTestDecoder do
  @moduledoc false
  # Strict JSON decode for test fixtures only — the same rules the lease contract
  # uses (objects, strings, non-negative integers; no escapes, floats, booleans or
  # null). A fixture that breaks those rules is meant to be rejected by the
  # schema, not quietly coerced here.

  def decode(bin) do
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

  defp string(<<"\"", rest::binary>>, acc), do: {acc |> Enum.reverse() |> List.to_string(), rest}
  defp string(<<"\\", _::binary>>, _acc), do: raise("escaped characters not allowed")
  defp string(<<c::utf8, rest::binary>>, acc) when c >= 0x20, do: string(rest, [c | acc])
  defp string(<<>>, _acc), do: raise("unterminated string")

  defp string(<<c, _::binary>>, _acc),
    do: raise("control character 0x#{Integer.to_string(c, 16)}")

  defp number(bin) do
    case Integer.parse(bin) do
      {n, rest} when n >= 0 -> {n, rest}
      _ -> raise "expected a non-negative integer"
    end
  end

  defp skip(<<c, rest::binary>>) when c in [?\s, ?\t, ?\n, ?\r], do: skip(rest)
  defp skip(bin), do: bin
end
