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
      deps: []
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {AgentosWorker.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp aliases do
    [
      check: ["format --check-formatted", "compile --warnings-as-errors", "test"]
    ]
  end
end
