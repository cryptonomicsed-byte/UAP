#!/usr/bin/env bash
# Staging concurrency drill for the durable queue (M2-12 / V6-06-03).
#
# Runs the 1/10/100 concurrent-worker drill against a real PostgreSQL queue and
# writes tests/out/elixir/staging-concurrency.json. Two modes:
#
#   * a staging database you point at:
#       TEST_DATABASE_URL=postgres://admin:...  TEST_WORKER_DATABASE_URL=postgres://worker:...
#       bash scripts/staging-concurrency.sh
#     (the admin login seeds fixtures and bypasses RLS; the worker login holds
#      only the granted transition functions)
#
#   * a disposable local database (root shell with a local PostgreSQL):
#       bash scripts/staging-concurrency.sh
#     It is created, migrated and dropped on exit; nothing existing is touched.
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
report="$repo_root/tests/out/elixir/staging-concurrency.json"

run_suite() {
  cd "$app_dir"
  mix test --only staging --include staging "$@"

  if [[ -f "$report" ]]; then
    echo
    echo "staging report: $report"
    python3 - "$report" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
for level in report["levels"]:
    print(
        "  concurrency {concurrency:>3}  enqueued {enqueued:>3}  claimed {claimed:>3}  "
        "settled {settled_ok:>3}  repeat-refused {duplicate_settle_refused:>3}  "
        "states {states}  {elapsed_ms}ms".format(**level)
    )
print("  violations:", report["violations"] or "none")
PY
  fi
}

if [[ -n "${TEST_DATABASE_URL:-}" || -n "${TEST_WORKER_DATABASE_URL:-}" ]]; then
  : "${TEST_DATABASE_URL:?set TEST_DATABASE_URL (admin login that seeds fixtures)}"
  : "${TEST_WORKER_DATABASE_URL:?set TEST_WORKER_DATABASE_URL (worker login with the granted transition functions)}"
  echo "Using TEST_DATABASE_URL/TEST_WORKER_DATABASE_URL; no database was created." >&2
  run_suite "$@"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "No database URLs given and not root: set TEST_DATABASE_URL and TEST_WORKER_DATABASE_URL, or run as root with a local PostgreSQL." >&2
  exit 2
fi

rand="$(openssl rand -hex 6)"
db="uap_staging_${rand}"
admin_role="uap_admin_${rand}"
worker_role="uap_worker_${rand}"
admin_password="$(openssl rand -hex 16)"
worker_password="$(openssl rand -hex 16)"
admin_url="postgres://${admin_role}:${admin_password}@127.0.0.1:5432/${db}"
worker_url="postgres://${worker_role}:${worker_password}@127.0.0.1:5432/${db}"

as_postgres() { su postgres -c "$1"; }

cleanup() {
  as_postgres "dropdb --if-exists '${db}'" >/dev/null 2>&1 || true
  as_postgres "psql -q -c 'DROP ROLE IF EXISTS \"${worker_role}\"' -c 'DROP ROLE IF EXISTS \"${admin_role}\"'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

as_postgres "psql -q -v ON_ERROR_STOP=1 \
  -c \"CREATE ROLE \\\"${admin_role}\\\" LOGIN BYPASSRLS PASSWORD '${admin_password}'\" \
  -c \"CREATE ROLE \\\"${worker_role}\\\" LOGIN NOINHERIT PASSWORD '${worker_password}'\" \
  -c \"CREATE DATABASE \\\"${db}\\\" OWNER \\\"${admin_role}\\\"\""

cd "$repo_root"
UAP_POSTGRES_ADMIN_URL="$admin_url" npm run -s db:postgres -- migrate >/dev/null
UAP_POSTGRES_ADMIN_URL="$admin_url" npm run -s db:postgres -- grant-job-worker --role "$worker_role" >/dev/null

TEST_DATABASE_URL="$admin_url" TEST_WORKER_DATABASE_URL="$worker_url" run_suite "$@"
