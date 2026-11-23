#!/usr/bin/env bash
# Provision a disposable PostgreSQL database for the Elixir queue tests
# (V6-06-03), apply the authoritative `uap` migrations from the repository, then
# run the :postgres suite against it. The database, its login role and the
# generated password are removed on exit; nothing touches an existing database.
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"

if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
  echo "Using TEST_DATABASE_URL from the environment; no database was created." >&2
  cd "$app_dir"
  exec mix test --only postgres --include postgres "$@"
fi

rand="$(openssl rand -hex 6)"
db="uap_worker_test_${rand}"
role="uap_worker_${rand}"
password="$(openssl rand -hex 16)"
url="postgres://${role}:${password}@127.0.0.1:5432/${db}"

as_postgres() { su postgres -c "$1"; }

cleanup() {
  as_postgres "dropdb --if-exists '${db}'" >/dev/null 2>&1 || true
  as_postgres "psql -q -c 'DROP ROLE IF EXISTS \"${role}\"'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

as_postgres "psql -q -v ON_ERROR_STOP=1 -c \"CREATE ROLE \\\"${role}\\\" LOGIN PASSWORD '${password}'\" -c \"CREATE DATABASE \\\"${db}\\\" OWNER \\\"${role}\\\"\""

cd "$repo_root"
UAP_POSTGRES_ADMIN_URL="$url" npm run -s db:postgres -- migrate >/dev/null

cd "$app_dir"
TEST_DATABASE_URL="$url" mix test --only postgres --include postgres "$@"
