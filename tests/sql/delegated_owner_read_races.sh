#!/usr/bin/env bash
# Disposable local-only two-session races for read_delegated_owner_deal (row 5a,
# docs/plans/row5-owner-read.md §5a "Boundary against revoke"). Requires the
# trustflow-localdb container; never targets a URL, never a hosted project.
#
# Fixture: the same fail-closed schema-only restore as
# tests/sql/events_v5_authority.sh (owners and ACLs kept, only the 7 reviewed
# platform event triggers left out), then the migrations up to the row 5 read.
# Every wait is observed (pg_blocking_pids), never slept for.
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${TF_FIXTURE_CONTAINER:-trustflow-localdb}"
db="trustflow_readraces_$$"
dump="/tmp/${db}.dump"
work="$(mktemp -d "${TMPDIR:-/tmp}/trustflowreadraces.XXXXXX")"
cleanup() {
  docker exec "$container" dropdb -U supabase_admin --if-exists --force "$db" >/dev/null 2>&1 || echo "Could not drop disposable database $db" >&2
  docker exec "$container" rm -f "$dump" "$dump.list" || echo "Could not remove $dump in the container" >&2
  rm -rf "$work"
}
trap cleanup EXIT
psql_pg() { docker exec -i "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }

docker exec "$container" createdb -U supabase_admin -O postgres "$db"
docker exec "$container" pg_dump -U supabase_admin -d postgres --schema-only -Fc -f "$dump"
docker exec "$container" pg_restore -l "$dump" > "$work/toc.full"
grep -c ' SCHEMA \| TABLE ' "$work/toc.full" >/dev/null || { echo 'fixture: TOC has no schemas or tables' >&2; exit 1; }
reviewed='ensure_rls
issue_graphql_placeholder
issue_pg_cron_access
issue_pg_graphql_access
issue_pg_net_access
pgrst_ddl_watch
pgrst_drop_watch'
awk '$4 == "EVENT" && $5 == "TRIGGER" { print $7 }' "$work/toc.full" | sort > "$work/excluded"
if [[ "$(cat "$work/excluded")" != "$reviewed" ]]; then
  echo 'fixture: event triggers differ from the reviewed set' >&2; exit 1
fi
awk '!($4 == "EVENT" && $5 == "TRIGGER")' "$work/toc.full" > "$work/toc.list"
[[ $(( $(wc -l < "$work/toc.full") - $(wc -l < "$work/toc.list") )) -eq 7 ]] || { echo 'fixture: TOC filter removed other than 7 entries' >&2; exit 1; }
docker cp "$work/toc.list" "$container:$dump.list"
echo 'fixture: restoring'
docker exec "$container" pg_restore -U supabase_admin -d "$db" --exit-on-error -L "$dump.list" "$dump"
echo 'fixture: applying migrations to head, row 4 and the row 5 read'
for m in 20261118214020_entry_agent_credentials 20261120090000_create_entry_contract \
         20261120180000_close_contract_client_insert 20261122130000_events_v5_authority_columns \
         20261124120000_entry_agent_resolver 20261124130000_delegated_owner_append \
         20261124231214_delegated_owner_read; do
  psql_pg -1 -f - < "supabase/migrations/$m.sql" > /dev/null
done

owner=11111111-1111-4111-8111-111111111111
c1=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1
c2=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2   # another deal, for a foreign grant
psql_pg > /dev/null <<SQL
insert into auth.users (id, email, is_anonymous, email_confirmed_at) values
  ('$owner', 'read-races@example.test', false, clock_timestamp());
insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy, performed_by) values
  ('$c1', '$owner', 'read races c1', '["test"]', 1, 'creator'),
  ('$c2', '$owner', 'read races c2', '["test"]', 1, 'creator');
insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, hash_version, payload_hash, dod_hash)
values (gen_random_uuid(), 'contract.initiated', '$c1', '$owner', '{"step":1}', clock_timestamp(), repeat('7', 64), 4, repeat('1', 64), repeat('3', 64));
create schema tf_race;
create function tf_race.grant(p_id uuid, p_contract uuid, p_hash text, p_ttl interval) returns void language sql as \$\$
  insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, expires_at)
  values (p_id, p_contract, '$owner', 'owner_account', p_hash, array['read'], clock_timestamp() + p_ttl) \$\$;
-- The read as the Edge caller would make it: status, and whether any data came back.
create function tf_race.read(p_contract uuid, p_cred uuid, p_hash text) returns text language sql as \$\$
  select r->>'status' || case when r ? 'events' or r ? 'contract' or r ? 'read_boundary' then '+data' else '' end
  from (select public.read_delegated_owner_deal(p_contract, p_cred, p_hash) r) s \$\$;
SQL

q() { psql_pg <<< "$1"; }
bg() { local app="$1" sql="$2"
  docker exec -e PGAPPNAME="$app" "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1 -c "$sql" > "$work/$app" 2>&1 & }
until_true() { local label="$1" sql="$2" i
  for i in {1..200}; do [[ "$(q "$sql")" == t ]] && return 0; sleep .05; done
  echo "FAIL timed out waiting for: $label" >&2; exit 1; }
pid_of() { q "select pid from pg_stat_activity where application_name = '$1' and datname = current_database()"; }
expect() { local label="$1" expected="$2" actual="$3"; [[ "$actual" == "$expected" ]] || { printf 'FAIL %s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2; exit 1; }; echo "PASS $label"; }
start_keeper() {
  bg rk_keeper "select pg_advisory_lock(4242); select pg_sleep(600)"; keeper=$!
  until_true 'keeper holds 4242' "select exists (select 1 from pg_locks l join pg_stat_activity a using (pid)
    where a.application_name = 'rk_keeper' and l.locktype = 'advisory' and l.objid = 4242 and l.granted)"
}
start_holder() {  # $1: statement run first in the holder's transaction
  bg rk_holder "begin; $1; select pg_advisory_xact_lock(4242); commit"; holder=$!
  until_true 'holder queued on 4242' "select exists (select 1 from pg_stat_activity
    where application_name = 'rk_holder' and wait_event_type = 'Lock' and wait_event = 'advisory')"
}
blocked_by_holder() {
  until_true "$1 blocked by the holder" "select coalesce((select (select pid from pg_stat_activity where application_name = 'rk_holder') = any(pg_blocking_pids(pid))
    from pg_stat_activity where application_name = '$1'), false)"
}
release() {
  q "select pg_terminate_backend($(pid_of rk_keeper))" > /dev/null
  wait "$keeper" 2>/dev/null || true; wait "$holder"
}
first_line() { head -1 "$work/$1"; }

# 1. Read first: revoke waits for the read transaction; the admitted read
#    returns its data; a fresh read afterwards is refused with nothing.
g=cccccccc-0000-4000-8000-0000000000d1
q "select tf_race.grant('$g', '$c1', repeat('1', 64), interval '1 day')" > /dev/null
start_keeper; start_holder "select tf_race.read('$c1', '$g', repeat('1', 64))"
bg rk_revoker "select public.revoke_entry_agent_credential('$c1', '$g', '$owner')->>'status'"; revoker=$!
blocked_by_holder rk_revoker
expect 'read first: grant still live while revoke waits' t "$(q "select revoked_at is null from public.entry_agent_credentials where id = '$g'")"
release; wait "$revoker"
expect 'read first: the admitted read returned data' ok+data "$(first_line rk_holder)"
expect 'read first: revoke completes after the read' revoked "$(first_line rk_revoker)"
expect 'after revoke: a fresh read is refused with no data' revoked "$(q "select tf_race.read('$c1', '$g', repeat('1', 64))")"

# 2. Revoke first: a read queued behind the revoke's locks is refused.
g=cccccccc-0000-4000-8000-0000000000d2
q "select tf_race.grant('$g', '$c1', repeat('2', 64), interval '1 day')" > /dev/null
start_keeper; start_holder "select public.revoke_entry_agent_credential('$c1', '$g', '$owner')"
bg rk_reader "select tf_race.read('$c1', '$g', repeat('2', 64))"; reader=$!
blocked_by_holder rk_reader
release; wait "$reader"
expect 'revoke first: the queued read is refused with no data' revoked "$(first_line rk_reader)"

# 3. Expiry while the read waits on the contract lock: the post-lock sample decides.
g=cccccccc-0000-4000-8000-0000000000d3
q "select tf_race.grant('$g', '$c1', repeat('3', 64), interval '3 seconds')" > /dev/null
start_keeper; start_holder "select id from public.contracts where id = '$c1' for update"
bg rk_reader "select tf_race.read('$c1', '$g', repeat('3', 64))"; reader=$!
blocked_by_holder rk_reader
expect 'expiry: grant live while the read is blocked' t "$(q "select expires_at > clock_timestamp() from public.entry_agent_credentials where id = '$g'")"
until_true 'grant expired' "select expires_at <= clock_timestamp() from public.entry_agent_credentials where id = '$g'"
release; wait "$reader"
expect 'expiry during the wait: refused expired with no data' expired "$(first_line rk_reader)"

# 4. A failed possession check returns while the contract is locked. Each runs
#    with lock_timeout 500ms, so touching the lock would end in 55P03.
g=cccccccc-0000-4000-8000-0000000000d4
q "select tf_race.grant('$g', '$c1', repeat('4', 64), interval '1 day')" > /dev/null
foreign=cccccccc-0000-4000-8000-0000000000d5
q "select tf_race.grant('$foreign', '$c2', repeat('5', 64), interval '1 day')" > /dev/null
absent=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9
start_keeper; start_holder "select id from public.contracts where id = '$c1' for update"
refused() { q "begin; set local lock_timeout = '500ms'; select tf_race.read('$1', '$2', repeat('$3', 64)); commit;" 2>&1 || true; }
expect 'held lock: unknown grant refused without waiting' grant_unknown "$(refused "$c1" cccccccc-0000-4000-8000-0000000000ff 4)"
expect 'held lock: wrong secret refused without waiting' secret_mismatch "$(refused "$c1" "$g" 9)"
expect "held lock: another deal's grant refused without waiting" grant_unknown "$(refused "$c1" "$foreign" 5)"
expect 'held lock: an absent deal is the same answer' grant_unknown "$(refused "$absent" "$g" 4)"
# The lock order is kept: a valid grant waits behind the held row, then reads.
bg rk_reader "select tf_race.read('$c1', '$g', repeat('4', 64))"; reader=$!
blocked_by_holder rk_reader
release; wait "$reader"
expect 'held lock: a valid grant waits for the lock, then reads' ok+data "$(first_line rk_reader)"

# 5. A held grant row (FOR UPDATE, as revoke takes it) also holds the read back.
g=cccccccc-0000-4000-8000-0000000000d6
q "select tf_race.grant('$g', '$c1', repeat('6', 64), interval '1 day')" > /dev/null
start_keeper; start_holder "select id from public.entry_agent_credentials where id = '$g' for update"
bg rk_reader "select tf_race.read('$c1', '$g', repeat('6', 64))"; reader=$!
blocked_by_holder rk_reader
release; wait "$reader"
expect 'held grant row: the read waits, then reads' ok+data "$(first_line rk_reader)"

echo 'ALL PASS'
