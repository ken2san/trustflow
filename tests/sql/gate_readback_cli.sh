#!/usr/bin/env bash
# Local-only evidence for the delegated trial's gate readback
# (scripts/lib/delegatedTrial.mjs queryGate), through the real CLI and under
# the same stripped child env a real run gives it (run()). T278 found that
# `supabase db query -o json` prints a bare array under that env and a
# { boundary, rows } wrapper under an agent shell; the query now pins
# --agent no and the parser accepts the bare array only.
#
# Requires the trustflow-localdb container and the installed supabase CLI.
# Never targets a hosted project: a disposable database and a throwaway login
# role with a fresh password (PGPASSWORD only), both dropped on exit.
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${TF_FIXTURE_CONTAINER:-trustflow-localdb}"
port="${TF_FIXTURE_PORT:-54322}"
db="trustflow_gatecli_$$"
role="tf_gate_probe_$$"
cleanup() {
  docker exec "$container" dropdb -U supabase_admin --if-exists --force "$db" >/dev/null 2>&1 || echo "Could not drop $db" >&2
  docker exec "$container" psql -X -qAt -U supabase_admin -d postgres -c "drop role if exists $role" >/dev/null 2>&1 || echo "Could not drop role $role" >&2
}
trap cleanup EXIT
admin() { docker exec -i "$container" psql -X -qAt -U supabase_admin -d "$db" -v ON_ERROR_STOP=1 "$@"; }

pw="$(openssl rand -hex 24)"
docker exec "$container" createdb -U supabase_admin "$db"
docker exec -i "$container" psql -X -qAt -U supabase_admin -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
create role $role login password '$pw';
SQL
# The gate's shape from 20261124120000_entry_agent_resolver.sql, minimal.
admin >/dev/null <<SQL
create schema private;
create table private.v5_write_gate (id boolean primary key default true check (id), open boolean not null);
insert into private.v5_write_gate (id, open) values (true, false);
grant usage on schema private to $role;
grant select, update on private.v5_write_gate to $role;
SQL
url="postgresql://$role@127.0.0.1:$port/$db?sslmode=disable&options=-c%20default_transaction_read_only%3Don"

gate() {  # prints queryGate's answer, or REFUSED: <message>
  TF_GATE_URL="$url" TF_GATE_PW="$pw" node --input-type=module -e "
    import { queryGate } from './scripts/lib/delegatedTrial.mjs'
    try { console.log(await queryGate({ dbUrl: process.env.TF_GATE_URL, password: process.env.TF_GATE_PW })) }
    catch (e) { console.log('REFUSED: ' + e.message) }"
}
expect() { [[ "$3" == "$2" ]] || { echo "FAIL $1: expected '$2', got '$3'" >&2; exit 1; }; echo "PASS $1"; }

expect 'gate closed reads closed (bare array under run() env)' closed "$(gate)"
admin -c "update private.v5_write_gate set open = true" >/dev/null
expect 'gate open reads open' open "$(gate)"
admin -c "delete from private.v5_write_gate" >/dev/null
expect 'no gate row fails closed' 'REFUSED: gate readback: not exactly one boolean gate row' "$(gate)"
admin -c "insert into private.v5_write_gate (id, open) values (true, false)" >/dev/null

# The connection gate() uses is read-only: a write through it is refused.
set +e
PGPASSWORD="$pw" supabase db query --agent no --db-url "$url" -o json "update private.v5_write_gate set open = true" >/dev/null 2>&1
rc=$?
set -e
[[ $rc -ne 0 ]] || { echo 'FAIL a write through the read-only connection succeeded' >&2; exit 1; }
expect 'a write through the read-only connection is refused' f "$(admin -c 'select open from private.v5_write_gate')"

# The pin holds in a full (possibly agent-detected) environment too: bare array.
raw="$(PGPASSWORD="$pw" supabase db query --agent no --db-url "$url" -o json "select open from private.v5_write_gate where id" 2>/dev/null)"
expect 'with --agent no the CLI prints a bare array even from this shell' array \
  "$(node -e 'const j = JSON.parse(process.argv[1]); console.log(Array.isArray(j) ? "array" : "wrapped")' "$raw")"
# And this shell is one where the shape matters: without the pin, is it wrapped?
raw="$(PGPASSWORD="$pw" supabase db query --db-url "$url" -o json "select open from private.v5_write_gate where id" 2>/dev/null)"
echo "INFO without --agent no this shell gets: $(node -e 'const j = JSON.parse(process.argv[1]); console.log(Array.isArray(j) ? "bare array" : "the agent wrapper")' "$raw")"
echo 'ALL PASS'
