#!/usr/bin/env bash
# Disposable local-only evidence that migration C (20261125214511_drop_v5_check)
# behaves under the real runner, `supabase db push --db-url`, not only under
# `psql -1` (T267: the CLI batch is atomic but not a transaction block, so a
# top-level LOCK TABLE was refused). Requires the trustflow-localdb container
# and the installed supabase CLI; never targets a hosted project.
#
# Proves, through the CLI:
#   * a precondition failure (TF951) and a post-drop self-test failure (TF957)
#     leave the CHECK in place and no history row for C;
#   * C waits behind an uncommitted trigger disable and then refuses (TF953);
#   * the events ACCESS EXCLUSIVE lock is taken by C's first DO block before
#     the gate wait, and is still held by the same backend when the DROP
#     CONSTRAINT starts, so the checks and the drop share one transaction;
#   * the successful apply drops the CHECK and records exactly one history row.
#
# Access: a throwaway login role (member of postgres) with a freshly generated
# password passed only via PGPASSWORD, dropped on exit. No secret file is read.
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${TF_FIXTURE_CONTAINER:-trustflow-localdb}"
port="${TF_FIXTURE_PORT:-54322}"
db="trustflow_dropcli_$$"
role="tf_cli_probe_$$"
dump="/tmp/${db}.dump"
work="$(mktemp -d "${TMPDIR:-/tmp}/trustflowdropcli.XXXXXX")"
C="${TF_C_FILE:-supabase/migrations/20261125214511_drop_v5_check.sql}"
cleanup() {
  docker exec "$container" dropdb -U supabase_admin --if-exists --force "$db" >/dev/null 2>&1 || echo "Could not drop $db" >&2
  docker exec "$container" psql -X -qAt -U supabase_admin -d postgres -c "drop role if exists $role" >/dev/null 2>&1 || echo "Could not drop role $role" >&2
  docker exec "$container" rm -f "$dump" "$dump.list" || true
  rm -rf "$work"
}
trap cleanup EXIT
psql_pg() { docker exec -i "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
psql_admin() { docker exec -i "$container" psql -X -qAt -U supabase_admin -d "$db" -v ON_ERROR_STOP=1 "$@"; }

# ── Fixture: the same fail-closed schema-only restore as drop_v5_check.sh, then A..B ──
docker exec "$container" createdb -U supabase_admin -O postgres "$db"
docker exec "$container" pg_dump -U supabase_admin -d postgres --schema-only -Fc -f "$dump"
docker exec "$container" pg_restore -l "$dump" > "$work/toc.full"
reviewed='ensure_rls
issue_graphql_placeholder
issue_pg_cron_access
issue_pg_graphql_access
issue_pg_net_access
pgrst_ddl_watch
pgrst_drop_watch'
awk '$4 == "EVENT" && $5 == "TRIGGER" { print $7 }' "$work/toc.full" | sort > "$work/excluded"
[[ "$(cat "$work/excluded")" == "$reviewed" ]] || { echo 'fixture: event triggers differ from the reviewed set' >&2; exit 1; }
awk '!($4 == "EVENT" && $5 == "TRIGGER")' "$work/toc.full" > "$work/toc.list"
docker cp "$work/toc.list" "$container:$dump.list"
docker exec "$container" pg_restore -U supabase_admin -d "$db" --exit-on-error -L "$dump.list" "$dump"
for m in 20261118214020_entry_agent_credentials 20261120090000_create_entry_contract \
         20261120180000_close_contract_client_insert 20261122130000_events_v5_authority_columns \
         20261124120000_entry_agent_resolver 20261124130000_delegated_owner_append; do
  psql_pg -1 -f - < "supabase/migrations/$m.sql" > /dev/null
done
echo 'PASS fixture: migrations through B apply'

# ── The CLI: a workdir holding only C, a throwaway login role ───────────────
mkdir -p "$work/cli/supabase/migrations"
cp "$C" "$work/cli/supabase/migrations/"
pw="$(openssl rand -hex 24)"
docker exec -i "$container" psql -X -qAt -U supabase_admin -d postgres -v ON_ERROR_STOP=1 > /dev/null <<SQL
create role $role login password '$pw' in role postgres;
SQL
url="postgresql://$role@127.0.0.1:$port/$db?sslmode=disable"
push() {  # prints the CLI output; returns its exit status
  (cd "$work/cli" && PGPASSWORD="$pw" supabase db push --db-url "$url" --yes 2>&1)
}
history_c() {
  psql_pg <<< "select case when to_regclass('supabase_migrations.schema_migrations') is null then 0
    else (select count(*) from supabase_migrations.schema_migrations where version = '20261125214511') end"
}
check_state() {  # $1 label: the CHECK is present and validated, no history row for C
  [[ "$(psql_pg <<< "select count(*) from pg_constraint where conname = 'events_v5_writes_disabled' and convalidated")" == 1 ]] \
    || { echo "FAIL $1: the CHECK is gone or not validated" >&2; exit 1; }
  [[ "$(history_c)" == 0 ]] || { echo "FAIL $1: a history row for C exists" >&2; exit 1; }
}
push_fails() {  # $1 SQLSTATE, $2 label
  local out rc
  set +e; out=$(push); rc=$?; set -e
  [[ $rc -ne 0 ]] || { echo "$out" >&2; echo "FAIL the CLI applied C ($2)" >&2; exit 1; }
  grep -q "$1" <<< "$out" || { echo "$out" >&2; echo "FAIL CLI on $2: expected $1" >&2; exit 1; }
  check_state "$2"
  echo "PASS CLI refuses C $2 ($1): CHECK present and validated, no history row"
}

# Records, at the start of every ALTER TABLE, whether this backend already holds
# ACCESS EXCLUSIVE on public.events. ddl_command_start fires before ALTER TABLE
# takes its own lock, so a hit at the DROP CONSTRAINT is the DO block's lock.
psql_admin > /dev/null <<SQL
create table public.tf_cli_lockcheck (query text, held boolean, at timestamptz default clock_timestamp());
grant insert on public.tf_cli_lockcheck to $role;
create function public.tf_cli_lockcheck_fn() returns event_trigger language plpgsql security definer set search_path = '' as \$f\$
begin
  insert into public.tf_cli_lockcheck (query, held)
  select current_query(), exists (select 1 from pg_catalog.pg_locks l
    where l.pid = pg_catalog.pg_backend_pid() and l.relation = 'public.events'::regclass
      and l.mode = 'AccessExclusiveLock' and l.granted);
end \$f\$;
create event trigger tf_cli_lockcheck on ddl_command_start when tag in ('ALTER TABLE') execute function public.tf_cli_lockcheck_fn();
SQL
drop_rows() { psql_pg <<< "select count(*) from public.tf_cli_lockcheck where query ilike '%drop constraint events_v5_writes_disabled%'"; }

# 1. Precondition failure: gate open.
psql_pg <<< "update private.v5_write_gate set open = true" > /dev/null
push_fails TF951 'with the gate open'
psql_pg <<< "update private.v5_write_gate set open = false" > /dev/null

# 2. Post-drop failure: another v5 constraint NOT VALID, so TF957 fires after the drop.
def=$(psql_pg <<< "select pg_get_constraintdef(oid) from pg_constraint where conname = 'events_v5_prev_link'")
psql_pg > /dev/null <<SQL
alter table public.events drop constraint events_v5_prev_link;
alter table public.events add constraint events_v5_prev_link $def not valid;
SQL
push_fails TF957 'when the self-test fails after the drop'
[[ "$(drop_rows)" == 0 ]] || { echo 'FAIL the DROP ran but its event-trigger row survived the rollback' >&2; exit 1; }
echo 'PASS the rolled-back DROP left no trace (its event-trigger row rolled back with it)'
psql_pg > /dev/null <<SQL
alter table public.events drop constraint events_v5_prev_link;
alter table public.events add constraint events_v5_prev_link $def;
SQL

# 3. A concurrent uncommitted trigger disable: C waits on its lock, then refuses.
( psql_pg <<< "begin; alter table public.events disable trigger v5_write_ticket_confirm; select pg_sleep(4); commit;" > /dev/null ) &
bg=$!
sleep 1.5
t0=$(date +%s)
set +e; out=$(push); rc=$?; set -e
waited=$(( $(date +%s) - t0 ))
wait "$bg"
[[ $rc -ne 0 ]] && grep -q TF953 <<< "$out" || { echo "$out" >&2; echo 'FAIL CLI C under a concurrent disable must fail TF953' >&2; exit 1; }
[[ $waited -ge 2 ]] || { echo "FAIL CLI C did not wait (${waited}s)" >&2; exit 1; }
check_state 'under a concurrent disable'
psql_pg <<< "alter table public.events enable trigger v5_write_ticket_confirm" > /dev/null
echo "PASS CLI C waits (${waited}s) behind a concurrent trigger disable, then refuses (TF953); CHECK present, no history row"

# 4. Success, with the gate row held FOR UPDATE by another session so C stops
#    after its lock: while it waits, the events ACCESS EXCLUSIVE lock must
#    already be granted to C's backend.
psql_pg <<< "truncate public.tf_cli_lockcheck" > /dev/null
( psql_pg <<< "begin; select open from private.v5_write_gate for update; select pg_sleep(4); commit;" > /dev/null ) &
bg=$!
sleep 1
( push > "$work/push.out"; echo $? > "$work/push.rc" ) &
cli=$!
sleep 1.5
seen=$(psql_pg <<< "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid
  where l.relation = 'public.events'::regclass and l.mode = 'AccessExclusiveLock' and l.granted
    and a.usename = '$role' and a.wait_event_type = 'Lock'")
wait "$bg"; wait "$cli"
[[ "$seen" == 1 ]] || { echo "FAIL while C waited on the gate, its backend did not hold the events lock ($seen)" >&2; exit 1; }
echo 'PASS while C waits on the gate row, its backend already holds ACCESS EXCLUSIVE on events'
[[ "$(cat "$work/push.rc")" == 0 ]] || { cat "$work/push.out" >&2; echo 'FAIL the CLI did not apply C' >&2; exit 1; }
got=$(psql_pg <<< "select (select count(*) from public.tf_cli_lockcheck where query ilike '%drop constraint events_v5_writes_disabled%' and held)
  || '|' || (select count(*) from public.tf_cli_lockcheck where query ilike '%drop constraint events_v5_writes_disabled%')")
[[ "$got" == '1|1' ]] || { echo "FAIL the DROP did not start under the DO block's lock ($got)" >&2; exit 1; }
echo 'PASS the DROP CONSTRAINT starts with the DO block lock still held by the same backend (one transaction)'
got=$(psql_pg <<< "select exists (select 1 from pg_constraint where conname = 'events_v5_writes_disabled')::text || '|' ||
  (select open from private.v5_write_gate)::text || '|' || $(history_c | tr -d '\n') || '|' ||
  (select count(*) from pg_trigger where tgrelid = 'public.events'::regclass and tgenabled = 'O'
     and tgname in ('zz_v5_write_ticket_check', 'v5_write_ticket_confirm'))")
[[ "$got" == 'false|false|1|2' ]] || { echo "FAIL after the CLI apply: $got" >&2; exit 1; }
echo 'PASS CLI applies C: CHECK gone, gate closed, one history row, both ticket triggers enabled'
echo 'ALL PASS'
