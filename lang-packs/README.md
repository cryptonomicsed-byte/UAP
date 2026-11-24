# Language gate pack fixtures (V6-11 / V6-08)

Each directory holds a minimal, deterministic fixture tree the language gate
runner can point at. Live tool runs still require the host toolchain; dry-run
and claim-without-evidence paths are covered by `tests/language-gates.test.mjs`.

| Pack | Fixture purpose |
|---|---|
| rust | `cargo metadata` shape + expected clippy deny list |
| elixir | mix test tags for supervision |
| julia | seeded numerical tolerance fixture |
| move | object-ownership vs capability notes |
| go | race-detector invocation contract |
| python | ruff/pytest/mypy command contract |
| clojure | kaocha/malli evaluation contract |

Profiles are versioned in `server/src/lib/language-gates.ts` (`LANGUAGE_GATE_PACKS`).
