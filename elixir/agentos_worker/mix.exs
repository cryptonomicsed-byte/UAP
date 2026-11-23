defmodule AgentosWorker.MixProject do
  use Mix.Project

  @version "0.1.0"

  def project do
    [
      app: :agentos_worker,
      version: @version,
      elixir: "~> 1.14",
      elixirc_paths: elixirc_paths(Mix.env()),
      elixirc_options: [warnings_as_errors: true],
      start_permanent: Mix.env() == :prod,
      preferred_cli_env: [check: :test],
      aliases: aliases(),
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger, :crypto],
      mod: {AgentosWorker.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  # The queue authority is PostgreSQL (V6-06-03); no Ecto, no second queue.
  defp deps do
    [
      {:postgrex, "~> 0.17.0"},
      {:jason, "~> 1.4"}
    ]
  end

  defp aliases do
    [
      check: ["format --check-formatted", "compile --warnings-as-errors", "test"],
      "test.postgres": ["cmd ./scripts/test-postgres.sh"]
    ]
  end
end
