#!/usr/bin/env bash
# Track F gate: the Elixir worker app must format, compile without warnings and
# pass ExUnit. Missing toolchain fails (exit 2) instead of silently passing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v mix >/dev/null 2>&1; then
  echo "test:elixir: FAIL (mix not installed; install Elixir/OTP)" >&2
  exit 2
fi

cd "$ROOT/elixir/agentos_worker"
exec mix check
