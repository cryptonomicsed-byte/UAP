#!/usr/bin/env bash
# Provision a disposable PostgreSQL database for the Elixir queue tests
# (V6-06-03): an admin login that owns the database and seeds fixtures, plus a
# separate worker login holding only the granted durable-transition functions —
# the same authority split the Node harness uses. Both roles and the database
# are removed on exit; nothing touches an existing database.
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"

if [[ -n "${TEST_DATABASE_URL:-}" && -n "${TEST_WORKER_DATABASE_URL:-}" ]]; then
  echo "Using TEST_DATABASE_URL/TEST_WORKER_DATABASE_URL from the environment; no database was created." >&2
  cd "$app_dir"
  exec mix test --only postgres --include postgres "$@"
fi

rand="$(openssl rand -hex 6)"
db="uap_worker_test_${rand}"
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

# uap.users has no INSERT policy and FORCE ROW LEVEL SECURITY, so fixtures are
# seeded by an admin login that bypasses RLS. The worker login must hold no
# table privileges at all; grant-job-worker below enforces and proves that.
as_postgres "psql -q -v ON_ERROR_STOP=1 -c \"CREATE ROLE \\\"${admin_role}\\\" LOGIN BYPASSRLS PASSWORD '${admin_password}'\" -c \"CREATE ROLE \\\"${worker_role}\\\" LOGIN NOINHERIT PASSWORD '${worker_password}'\" -c \"CREATE DATABASE \\\"${db}\\\" OWNER \\\"${admin_role}\\\"\""

cd "$repo_root"
UAP_POSTGRES_ADMIN_URL="$admin_url" npm run -s db:postgres -- migrate >/dev/null
UAP_POSTGRES_ADMIN_URL="$admin_url" npm run -s db:postgres -- grant-job-worker --role "$worker_role" >/dev/null

cd "$app_dir"
TEST_DATABASE_URL="$admin_url" TEST_WORKER_DATABASE_URL="$worker_url" \
  mix test --only postgres --include postgres "$@"
