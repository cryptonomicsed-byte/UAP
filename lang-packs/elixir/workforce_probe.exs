# Disposable worker probe. The SID is not created here.
# Usage: elixir workforce_probe.exs spawn sid_example
# Prints TERMINATED after the short-lived process exits.
sid = System.argv() |> List.last() || "sid_unbound"
IO.puts("SPAWN #{sid}")
task = Task.async(fn -> :ok end)
Task.await(task, 2_000)
IO.puts("TERMINATED #{sid}")
