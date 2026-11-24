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
  -- No client role or service_role reaches the resolver or the gate.
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    begin
      execute format('set local role %I', v_role);
      perform * from private.resolve_entry_agent_grant('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', false);
      raise exception 'FAIL % executed the resolver', v_role;
    exception when insufficient_privilege then null; end;
    begin
      execute format('set local role %I', v_role);
      perform 1 from private.v5_write_gate;
      raise exception 'FAIL % read the gate', v_role;
    exception when insufficient_privilege then null; end;
    begin
      execute format('set local role %I', v_role);
      update private.v5_write_gate set open = true;
      raise exception 'FAIL % opened the gate', v_role;
    exception when insufficient_privilege then null; end;
    reset role;
    raise notice 'PASS % gets 42501 on the resolver and the gate', v_role;
  end loop;
end \$\$;
SQL
psql_pg > "$work/rr.out" 2>&1 <<SQL || true
begin isolation level repeatable read;
select status from private.resolve_entry_agent_grant('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', false);
SQL
grep -q 'only guaranteed under READ COMMITTED' "$work/rr.out" || { cat "$work/rr.out" >&2; echo 'FAIL REPEATABLE READ not refused' >&2; exit 1; }
echo 'PASS REPEATABLE READ refused (TF005)'

# ── Lock waits: the clock is sampled after the last lock ────────────────────
hold() {
  local statement="$1" i
  docker exec -e PGAPPNAME=resolver_hold "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1 \
    -c "begin; $statement; select pg_sleep(4); commit" > "$work/holder" 2>&1 &
  holder=$!
  for i in {1..100}; do
    if [[ "$(psql_pg <<< "select count(*) from pg_stat_activity where application_name='resolver_hold' and wait_event='PgSleep'")" == 1 ]]; then return; fi
    kill -0 "$holder" 2>/dev/null || { cat "$work/holder" >&2; return 1; }
    sleep .05
  done
  echo 'lock holder did not enter sleep' >&2; return 1
}
expect() { local label="$1" expected="$2" actual="$3"; [[ "$actual" == "$expected" ]] || { printf 'FAIL %s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2; exit 1; }; echo "PASS $label"; }
short_grant() {
  psql_pg > /dev/null <<< "insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, expires_at)
    values ('$1', '$c1', '$owner', 'owner_account', repeat('$2', 64), array['performance.asserted'], clock_timestamp() + interval '1 second')"
}
# The waiter's result row: status, and whether its clock sample is after the
# holder released (the holder sleeps 4 s; a pre-lock sample would be ~0 s).
waiter() { psql_pg <<< "create temp table t0 as select clock_timestamp() as t;
  select r.status || ':' || (r.now - (select t from t0) > interval '3 seconds')::text
  from private.resolve_entry_agent_grant('$c1', '$1', repeat('$2', 64), 'performance.asserted', $3) r"; }

short_grant cccccccc-0000-4000-8000-0000000000a1 1
hold "select id from public.contracts where id = '$c1' for update"
actual=$(waiter cccccccc-0000-4000-8000-0000000000a1 1 false); wait "$holder"
expect 'expiry while waiting on the contract lock; one sample after it' 'expired:true' "$actual"

short_grant cccccccc-0000-4000-8000-0000000000a2 2
hold "select id from public.entry_agent_credentials where id = 'cccccccc-0000-4000-8000-0000000000a2' for update"
actual=$(waiter cccccccc-0000-4000-8000-0000000000a2 2 false); wait "$holder"
expect 'expiry while waiting on the grant row lock' 'expired:true' "$actual"

psql_pg <<< "update private.v5_write_gate set open = true" > /dev/null
short_grant cccccccc-0000-4000-8000-0000000000a3 3
hold "update private.v5_write_gate set open = true"
actual=$(waiter cccccccc-0000-4000-8000-0000000000a3 3 true); wait "$holder"
expect 'expiry while waiting on the gate row lock' 'expired:true' "$actual"

# A close committed while an append waits on the gate: the append re-reads it.
hold "update private.v5_write_gate set open = false"
actual=$(waiter "$ok_grant" a true); wait "$holder"
expect 'close committed during the gate wait gives gate_closed' 'gate_closed:true' "$actual"

# An admitted append holds the gate share lock: the close waits for it.
psql_pg <<< "update private.v5_write_gate set open = true" > /dev/null
hold "select status from private.resolve_entry_agent_grant('$c1', '$ok_grant', '$ok_hash', 'performance.asserted', true)"
actual=$(psql_pg <<< "create temp table t0 as select clock_timestamp() as t;
  update private.v5_write_gate set open = false;
  select (clock_timestamp() - (select t from t0) > interval '3 seconds')::text"); wait "$holder"
grep -q '^ok$' "$work/holder" || { cat "$work/holder" >&2; echo 'FAIL holder was not admitted' >&2; exit 1; }
expect 'close waits for an append holding the gate share lock' 'true' "$actual"
expect 'gate is closed at the end' 'f' "$(psql_pg <<< "select open from private.v5_write_gate")"

# ── Inventory: the resolver is the only new function naming the grant table ─
psql_pg < tests/sql/entry_agent_credentials_inventory.sql > "$work/inventory.out" 2>&1
grep -i 'fail\|error' "$work/inventory.out" && { echo 'inventory reported a failure' >&2; exit 1; }
echo 'PASS bypass inventory with the resolver present'
echo 'ALL PASS'
