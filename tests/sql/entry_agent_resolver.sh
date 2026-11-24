#!/usr/bin/env bash
# Disposable local-only evidence for 20261124120000_entry_agent_resolver (row 4a,
# docs/plans/row4-owner-append.md). Requires the trustflow-localdb container;
# never targets a URL, never a hosted project.
#
# Fixture: the same fail-closed schema-only restore as
# tests/sql/events_v5_authority.sh (owners and ACLs kept, only the 7 reviewed
# platform event triggers left out), then the migrations up to today's head and
# the resolver migration. No event is written: the resolver only reads.
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${TF_FIXTURE_CONTAINER:-trustflow-localdb}"
db="trustflow_resolver_$$"
dump="/tmp/${db}.dump"
work="$(mktemp -d "${TMPDIR:-/tmp}/trustflowresolver.XXXXXX")"
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
echo 'fixture: applying migrations to head, then the resolver'
for m in 20261118214020_entry_agent_credentials 20261120090000_create_entry_contract \
         20261120180000_close_contract_client_insert 20261122130000_events_v5_authority_columns \
         20261124120000_entry_agent_resolver; do
  psql_pg -1 -f - < "supabase/migrations/$m.sql" > /dev/null
done
echo 'PASS migration applies with its self-test (TF921-TF923)'

owner=11111111-1111-4111-8111-111111111111
other=22222222-2222-4222-8222-222222222222
c1=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1
c2=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2
ok_grant=cccccccc-0000-4000-8000-000000000001
ok_hash=$(printf 'a%.0s' {1..64})
psql_pg > /dev/null <<SQL
insert into auth.users (id, email, is_anonymous, email_confirmed_at) values
  ('$owner', 'resolver-owner@example.test', false, clock_timestamp()),
  ('$other', 'resolver-other@example.test', false, clock_timestamp());
insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy) values
  ('$c1', '$owner', 'resolver c1', '["test"]', 1),
  ('$c2', '$owner', 'resolver c2', '["test"]', 1);
insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, created_at, expires_at, revoked_at) values
  ('$ok_grant',                            '$c1', '$owner', 'owner_account',       '$ok_hash',       array['performance.asserted','read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('cccccccc-0000-4000-8000-000000000002', '$c1', '$other', 'counterpart_account', repeat('b', 64), array['performance.accepted'],       clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('cccccccc-0000-4000-8000-000000000003', '$c1', '$other', 'owner_account',       repeat('c', 64), array['performance.asserted'],       clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('cccccccc-0000-4000-8000-000000000004', '$c1', '$owner', 'owner_account',       repeat('d', 64), array['performance.asserted'],       clock_timestamp(), clock_timestamp() + interval '1 day', clock_timestamp()),
  ('cccccccc-0000-4000-8000-000000000005', '$c1', '$owner', 'owner_account',       repeat('e', 64), array['performance.asserted'],       clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day', null),
  ('cccccccc-0000-4000-8000-000000000006', '$c2', '$owner', 'owner_account',       repeat('f', 64), array['performance.asserted'],       clock_timestamp(), clock_timestamp() + interval '1 day', null);
SQL

# ── Status codes, ACLs, isolation and the gate guard ────────────────────────
psql_pg <<SQL
create function pg_temp.st(p_contract uuid, p_grant uuid, p_hash text, p_op text, p_insert boolean) returns text
language sql as \$\$ select status from private.resolve_entry_agent_grant(p_contract, p_grant, p_hash, p_op, p_insert) \$\$;
create function pg_temp.expect(p_label text, p_expected text, p_actual text) returns void language plpgsql as \$\$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'PASS %', p_label;
end \$\$;
select pg_temp.expect('ok for replay (gate not read)', 'ok', pg_temp.st('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', false));
select pg_temp.expect('gate_closed for append while the gate is closed', 'gate_closed', pg_temp.st('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', true));
select pg_temp.expect('malformed hash', 'malformed', pg_temp.st('$c1', '$ok_grant', 'xyz', 'performance.asserted', false));
select pg_temp.expect('malformed null operation', 'malformed', pg_temp.st('$c1', '$ok_grant', '$ok_hash', null, false));
select pg_temp.expect('grant_unknown: no such deal', 'grant_unknown', pg_temp.st('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9', '$ok_grant', '$ok_hash', 'performance.asserted', false));
select pg_temp.expect('grant_unknown: no such grant', 'grant_unknown', pg_temp.st('$c1', 'cccccccc-0000-4000-8000-000000000099', '$ok_hash', 'performance.asserted', false));
select pg_temp.expect('grant_unknown: grant of another deal', 'grant_unknown', pg_temp.st('$c1', 'cccccccc-0000-4000-8000-000000000006', repeat('f', 64), 'performance.asserted', false));
select pg_temp.expect('secret_mismatch', 'secret_mismatch', pg_temp.st('$c1', '$ok_grant', repeat('9', 64), 'performance.asserted', false));
select pg_temp.expect('issuer_kind: counterpart grant', 'issuer_kind', pg_temp.st('$c1', 'cccccccc-0000-4000-8000-000000000002', repeat('b', 64), 'performance.accepted', false));
select pg_temp.expect('issuer_not_owner', 'issuer_not_owner', pg_temp.st('$c1', 'cccccccc-0000-4000-8000-000000000003', repeat('c', 64), 'performance.asserted', false));
select pg_temp.expect('revoked', 'revoked', pg_temp.st('$c1', 'cccccccc-0000-4000-8000-000000000004', repeat('d', 64), 'performance.asserted', false));
select pg_temp.expect('expired', 'expired', pg_temp.st('$c1', 'cccccccc-0000-4000-8000-000000000005', repeat('e', 64), 'performance.asserted', false));
select pg_temp.expect('scope: type outside the grant', 'scope', pg_temp.st('$c1', '$ok_grant', '$ok_hash', 'performance.accepted', false));
select pg_temp.expect('allowlist: read is granted but not a row 4 write', 'allowlist', pg_temp.st('$c1', '$ok_grant', '$ok_hash', 'read', false));
do \$\$
declare r record;
begin
  select * into r from private.resolve_entry_agent_grant('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', false);
  if r.issuer_id is distinct from '$owner'::uuid or r.issuer_kind is distinct from 'owner_account' or r.now is null then
    raise exception 'FAIL ok returns issuer and now: %', r;
  end if;
  select * into r from private.resolve_entry_agent_grant('$c1', '$ok_grant', repeat('9', 64), 'performance.asserted', false);
  if r.issuer_id is not null or r.issuer_kind is not null then
    raise exception 'FAIL a refusal returns no issuer: %', r;
  end if;
  raise notice 'PASS ok returns issuer and now; a refusal returns no issuer';
end \$\$;
-- Open gate: append is ok; missing gate: fails closed. Both rolled back.
begin;
update private.v5_write_gate set open = true;
select pg_temp.expect('ok for append once the gate is open', 'ok', pg_temp.st('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', true));
alter table private.v5_write_gate disable trigger v5_write_gate_no_delete;
delete from private.v5_write_gate;
select pg_temp.expect('gate_missing for append', 'gate_missing', pg_temp.st('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', true));
select pg_temp.expect('replay unaffected by a missing gate', 'ok', pg_temp.st('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', false));
rollback;
select pg_temp.expect('gate is one closed row after rollback', '1:false', (select count(*) || ':' || bool_or(open) from private.v5_write_gate));
do \$\$
declare v_role text; v_state text;
begin
  -- Gate guard.
  begin delete from private.v5_write_gate; raise exception 'FAIL gate delete allowed';
  exception when sqlstate 'TF009' then null; end;
  begin truncate private.v5_write_gate; raise exception 'FAIL gate truncate allowed';
  exception when sqlstate 'TF009' then null; end;
  raise notice 'PASS gate delete and truncate raise TF009';
  -- No client role or service_role reaches the resolver or the gate. The role
  -- switch is outside each handler and asserted, so a failed switch can't
  -- satisfy the expected 42501.
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    execute format('set local role %I', v_role);
    if current_user is distinct from v_role then raise exception 'FAIL role switch to %', v_role; end if;
    begin
      perform * from private.resolve_entry_agent_grant('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', false);
      raise exception 'FAIL % executed the resolver', v_role;
    exception when insufficient_privilege then null; end;
    begin
      perform 1 from private.v5_write_gate;
      raise exception 'FAIL % read the gate', v_role;
    exception when insufficient_privilege then null; end;
    begin
      update private.v5_write_gate set open = true;
      raise exception 'FAIL % opened the gate', v_role;
    exception when insufficient_privilege then null; end;
    reset role;
    if current_user is distinct from 'postgres' then raise exception 'FAIL role reset'; end if;
    raise notice 'PASS % gets 42501 on the resolver and the gate', v_role;
  end loop;
end \$\$;
-- Authorization precedes gate state: an expired grant on a closed gate is
-- 'expired' (403), never the operational 'gate_closed' (503).
select pg_temp.expect('expired grant on a closed gate, append', 'expired', pg_temp.st('$c1', 'cccccccc-0000-4000-8000-000000000005', repeat('e', 64), 'performance.asserted', true));
-- Exactly TF005 under REPEATABLE READ: the handler catches only that SQLSTATE.
begin isolation level repeatable read;
do \$\$ begin
  perform * from private.resolve_entry_agent_grant('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', false);
  raise exception 'FAIL REPEATABLE READ was not refused';
exception when sqlstate 'TF005' then raise notice 'PASS REPEATABLE READ refused with exactly TF005'; end \$\$;
rollback;
SQL

# ── Lock waits: condition-based, no timing thresholds ───────────────────────
# A keeper session holds advisory lock 4242 until it is terminated. Each holder
# takes the lock under test, then queues on 4242, so it holds that lock for as
# long as the test decides. The waiter is observed blocked by that holder (and
# its grant observed live at that moment) before the keeper is released.
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
start_holder() {  # $1: statement taking the lock under test
  bg rk_holder "begin; $1; select pg_advisory_xact_lock(4242); commit"; holder=$!
  until_true 'holder queued on 4242' "select exists (select 1 from pg_stat_activity
    where application_name = 'rk_holder' and wait_event_type = 'Lock' and wait_event = 'advisory')"
}
blocked_by_holder() {  # $1: app name of the blocked session
  until_true "$1 blocked by the holder" "select coalesce((select (select pid from pg_stat_activity where application_name = 'rk_holder') = any(pg_blocking_pids(pid))
    from pg_stat_activity where application_name = '$1'), false)"
}
release() {  # Records the release instant, then frees the holder.
  t_release=$(q "select clock_timestamp()")
  q "select pg_terminate_backend($(pid_of rk_keeper))" > /dev/null
  wait "$keeper" 2>/dev/null || true; wait "$holder"
}
short_grant() {  # $1 id, $2 hash char: a grant that expires 3 s from now
  q "insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, expires_at)
    values ('$1', '$c1', '$owner', 'owner_account', repeat('$2', 64), array['performance.asserted'], clock_timestamp() + interval '3 seconds')" > /dev/null
}
# One expiry-during-wait case: the grant is live while the waiter is blocked,
# expires before release, and the answer's clock sample follows the release.
expiry_case() {  # $1 label, $2 holder statement, $3 grant id, $4 hash char, $5 p_for_insert
  short_grant "$3" "$4"
  start_keeper; start_holder "$2"
  bg rk_waiter "select r.status || '|' || r.now from private.resolve_entry_agent_grant('$c1', '$3', repeat('$4', 64), 'performance.asserted', $5) r"; waiter=$!
  blocked_by_holder rk_waiter
  expect "$1: grant live while the waiter is blocked" t "$(q "select expires_at > clock_timestamp() from public.entry_agent_credentials where id = '$3'")"
  until_true 'grant expired' "select expires_at <= clock_timestamp() from public.entry_agent_credentials where id = '$3'"
  release; wait "$waiter"
  local out; out=$(cat "$work/rk_waiter")
  expect "$1: answer" expired "${out%%|*}"
  expect "$1: clock sampled after the lock was released" t "$(q "select '${out#*|}'::timestamptz > '$t_release'::timestamptz")"
}
expiry_case 'contract lock' "select id from public.contracts where id = '$c1' for update" cccccccc-0000-4000-8000-0000000000a1 1 false
expiry_case 'grant row lock' "select id from public.entry_agent_credentials where id = 'cccccccc-0000-4000-8000-0000000000a2' for update" cccccccc-0000-4000-8000-0000000000a2 2 false
q "update private.v5_write_gate set open = true" > /dev/null
expiry_case 'gate row lock' "update private.v5_write_gate set open = true" cccccccc-0000-4000-8000-0000000000a3 3 true

# A close committed while an append waits on the gate: the append re-reads it.
start_keeper; start_holder "update private.v5_write_gate set open = false"
bg rk_waiter "select r.status || '|' || r.now from private.resolve_entry_agent_grant('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', true) r"; waiter=$!
blocked_by_holder rk_waiter
release; wait "$waiter"; out=$(cat "$work/rk_waiter")
expect 'close committed during the gate wait gives gate_closed' gate_closed "${out%%|*}"
expect 'gate_closed clock sampled after the close committed' t "$(q "select '${out#*|}'::timestamptz > '$t_release'::timestamptz")"

# An admitted append holds the gate share lock: the close waits for it.
q "update private.v5_write_gate set open = true" > /dev/null
start_keeper; start_holder "select status from private.resolve_entry_agent_grant('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', true)"
bg rk_closer "update private.v5_write_gate set open = false"; closer=$!
blocked_by_holder rk_closer
expect 'gate still open while the close waits' t "$(q "select open from private.v5_write_gate")"
release; wait "$closer"
grep -q '^ok$' "$work/rk_holder" || { cat "$work/rk_holder" >&2; echo 'FAIL holder was not admitted' >&2; exit 1; }
expect 'close completes after the admitted append ends; gate closed' f "$(q "select open from private.v5_write_gate")"


# ── Inventory: the resolver is the only new function naming the grant table ─
psql_pg < tests/sql/entry_agent_credentials_inventory.sql > "$work/inventory.out" 2>&1
grep -i 'fail\|error' "$work/inventory.out" && { echo 'inventory reported a failure' >&2; exit 1; }
echo 'PASS bypass inventory with the resolver present'
echo 'ALL PASS'
