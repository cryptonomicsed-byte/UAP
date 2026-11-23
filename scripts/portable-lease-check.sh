#!/usr/bin/env bash
# V6-05-09 — portable lease verification harness.
#
# Runs every committed golden fixture through each available verifier (Rust, Python,
# Go, Elixir) and asserts two things per fixture:
#   1. the verifier's conclusion (valid / invalid) equals `expect.txt`;
#   2. every language rebuilds the *same canonical bytes* (identical sha256), so a
#      serializer that orders keys or formats integers differently cannot pass.
#
# Exit codes: 0 = all available languages pass, 1 = a verifier disagreed or diverged,
#             2 = a required toolchain is missing (set REQUIRE_ALL=1 in CI), or the
#             Rust build failed.
#
# Usage: bash scripts/portable-lease-check.sh
# Env:   REQUIRE_ALL=1      treat a missing language as a failure
#        PORTABLE_LEASE_OUT output dir (default: artifacts/portable-lease)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/crates/agentos-policy/fixtures"
OUT="${PORTABLE_LEASE_OUT:-$ROOT/artifacts/portable-lease}"
REQUIRE_ALL="${REQUIRE_ALL:-0}"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "portable-lease-check: building the Rust verifier"
if ! cargo build -q --manifest-path "$ROOT/Cargo.toml" -p agentos-policy --bin verify-lease; then
  echo "portable-lease-check: FAIL (cargo build)"
  exit 2
fi
RUST_BIN="$ROOT/target/debug/verify-lease"

have() { command -v "$1" >/dev/null 2>&1; }

GO_BIN=""
if have go; then
  if (cd "$ROOT/crates/agentos-policy/verifiers/go" && go build -o "$WORK/verify-lease-go" .); then
    GO_BIN="$WORK/verify-lease-go"
  else
    echo "portable-lease-check: go build failed"
    exit 2
  fi
fi

declare -a LANGS=()
avail() { # lang binary
  if [ -n "$2" ]; then LANGS+=("$1"); else
    echo "portable-lease-check: missing toolchain for $1"
  fi
}
avail rust "$RUST_BIN"
[ -x "$RUST_BIN" ] || { echo "portable-lease-check: FAIL (no rust binary)"; exit 2; }
if have python3; then avail python python3; else avail python ""; fi
if [ -n "$GO_BIN" ]; then avail go "$GO_BIN"; else avail go ""; fi
if have elixir; then avail elixir elixir; else avail elixir ""; fi

if [ "$REQUIRE_ALL" = "1" ] && [ "${#LANGS[@]}" -ne 4 ]; then
  echo "portable-lease-check: FAIL (REQUIRE_ALL=1 but only ${#LANGS[@]}/4 toolchains present)"
  exit 2
fi

run_lang() { # lang dir
  case "$1" in
    rust) "$RUST_BIN" "$2" ;;
    python) python3 "$ROOT/scripts/verify-lease.py" "$2" ;;
    go) "$GO_BIN" "$2" ;;
    elixir) elixir "$ROOT/crates/agentos-policy/verifiers/verify_lease.exs" "$2" ;;
    *) echo "unknown language $1"; return 9 ;;
  esac
}

fail=0
fixtures=0
runs=0
REPORT="$OUT/report.txt"
: > "$REPORT"

for dir in "$FIXTURES"/*/; do
  [ -d "$dir" ] || continue
  fixtures=$((fixtures + 1))
  name="$(basename "$dir")"
  expect="$(tr -d '[:space:]' < "$dir/expect.txt")"
  shas=""
  line="$name expect=$expect"

  for lang in "${LANGS[@]}"; do
    out="$(run_lang "$lang" "$dir" 2>&1)"
    code=$?
    runs=$((runs + 1))
    sha="$(printf '%s' "$out" | sed -n 's/.*sha256=\([0-9a-f-]*\).*/\1/p' | head -1)"
    got="$(printf '%s' "$out" | sed -n 's/.*got=\([a-z]*\).*/\1/p' | head -1)"
    if [ "$code" -ne 0 ]; then
      echo "FAIL  $name  $lang  exit=$code  $out"
      fail=1
    elif [ "$got" != "$expect" ]; then
      echo "FAIL  $name  $lang  concluded $got, expected $expect"
      fail=1
    else
      echo "ok    $name  $lang  sha256=${sha}"
    fi
    printf '%s\n' "$out" >> "$REPORT"
    if [ -n "$sha" ] && [ "$sha" != "-" ]; then shas="$shas $sha"; fi
  done

  distinct="$(printf '%s\n' $shas | sort -u | wc -l | tr -d ' ')"
  if [ "$distinct" -gt 1 ]; then
    echo "FAIL  $name  canonical bytes diverged across languages:$shas"
    fail=1
  fi
  line="$line langs=${#LANGS[@]} sha256=$(printf '%s\n' $shas | sort -u | head -1)"
  echo "$line" >> "$REPORT"
done

echo
echo "portable-lease-check: $fixtures fixtures, $runs verifier runs, ${#LANGS[@]} languages (${LANGS[*]})"
ls "$FIXTURES" > "$OUT/fixtures.txt" 2>/dev/null
if [ "$fail" -ne 0 ]; then
  echo "portable-lease-check: FAIL"
  exit 1
fi
echo "portable-lease-check: PASS"
exit 0
