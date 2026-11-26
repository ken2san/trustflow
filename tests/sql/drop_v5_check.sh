#!/usr/bin/env bash
# Disposable local-only evidence for 20261125214511_drop_v5_check (row 4
# migration C, docs/plans/row4-owner-append.md §4c). Requires the
# trustflow-localdb container; never targets a URL, never a hosted project.
#
# Proves that once `events_v5_writes_disabled` is gone, the closed gate and the
# write-ticket triggers still refuse every v5 write on their own, that the
# writer and v4 writes still work, and that C refuses to apply unless migration
# B is in place with the gate closed.
#
# Fixture: the same fail-closed schema-only restore as tests/sql/delegated_append.sh,
# then the migrations up to the writer (B), then C.
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${TF_FIXTURE_CONTAINER:-trustflow-localdb}"
db="trustflow_dropcheck_$$"
pre="trustflow_dropcheck_pre_$$"
dump="/tmp/${db}.dump"
work="$(mktemp -d "${TMPDIR:-/tmp}/trustflowdropcheck.XXXXXX")"
C=supabase/migrations/20261125214511_drop_v5_check.sql
cleanup() {
  for d in "$db" "$pre"; do
    docker exec "$container" dropdb -U supabase_admin --if-exists --force "$d" >/dev/null 2>&1 || echo "Could not drop disposable database $d" >&2
  done
  docker exec "$container" rm -f "$dump" "$dump.list" || echo "Could not remove $dump in the container" >&2
  rm -rf "$work"
}
trap cleanup EXIT
psql_pg() { docker exec -i "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
psql_pre() { docker exec -i "$container" psql -X -qAt -U postgres -d "$pre" -v ON_ERROR_STOP=1 "$@"; }

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
upto_b='20261118214020_entry_agent_credentials 20261120090000_create_entry_contract
  20261120180000_close_contract_client_insert 20261122130000_events_v5_authority_columns
  20261124120000_entry_agent_resolver 20261124130000_delegated_owner_append'
for m in $upto_b; do psql_pg -1 -f - < "supabase/migrations/$m.sql" > /dev/null; done
echo 'PASS migrations through B apply'

# ── C's preconditions, on a second database (every failure rolls C back) ───
docker exec "$container" createdb -U supabase_admin -O postgres "$pre"
docker exec "$container" pg_restore -U supabase_admin -d "$pre" --exit-on-error -L "$dump.list" "$dump"
apply_c_pre() {  # $1: the SQLSTATE C must fail with, $2: label, $3: optional drift SQL run first in C's
                 # transaction (so the failure rolls it back too), $4: optional psql user. Asserts the CHECK is still
                 # there and, with drift, that the catalog fingerprint is exactly what it was before.
  local out rc
  set +e
  out=$( { printf '%s\n' "${3:-}"; cat "$C"; } | docker exec -i "$container" psql -X -qAt -U "${4:-postgres}" -d "$pre" \
         -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -1 -f - 2>&1); rc=$?
  set -e
  [[ $rc -ne 0 ]] || { echo "FAIL C applied where it must not ($2)" >&2; exit 1; }
  grep -q "ERROR:  $1:" <<< "$out" || { echo "$out" >&2; echo "FAIL C on $2: expected $1" >&2; exit 1; }
  [[ "$(psql_pre <<< "select count(*) from pg_constraint where conname = 'events_v5_writes_disabled' and convalidated")" == 1 ]] \
    || { echo "FAIL C on $2 left the CHECK dropped or not validated" >&2; exit 1; }
  if [[ -n "${3:-}" ]]; then
    [[ "$(fingerprint)" == "$fp" ]] || { echo "FAIL C on $2: the catalog differs after the rollback" >&2; exit 1; }
    echo "PASS C refuses to apply $2 ($1); the CHECK and the catalog are as before"
  else
    echo "PASS C refuses to apply $2 ($1); the CHECK is still present"
  fi
}
# Everything C checks or could be drifted by a case: triggers on events, its constraints, the gate, the trigger
# functions, table and column ACLs of the private objects, event triggers, and any test-only function.
fingerprint() {
  psql_pre <<'SQL'
select md5(concat_ws('#',
  (select string_agg(pg_get_triggerdef(oid) || tgenabled::text, '|' order by tgname) from pg_trigger
    where tgrelid = 'public.events'::regclass and not tgisinternal),
  (select string_agg(conname || convalidated::text || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint
    where conrelid = 'public.events'::regclass),
  (select open::text from private.v5_write_gate),
  (select string_agg(proname || md5(prosrc) || prosecdef::text || coalesce(proconfig::text, '') || coalesce(proacl::text, ''), '|'
     order by proname) from pg_proc where pronamespace = 'private'::regnamespace and proname like 'v5_write_ticket%'),
  (select string_agg(relname || coalesce(relacl::text, ''), '|' order by relname) from pg_class
    where oid in ('private.v5_write_gate'::regclass, 'private.v5_write_tickets'::regclass)),
  (select string_agg(attrelid::regclass::text || attname || coalesce(attacl::text, ''), '|' order by attrelid, attnum)
     from pg_attribute where attrelid in ('private.v5_write_gate'::regclass, 'private.v5_write_tickets'::regclass) and attnum > 0),
  (select count(*)::text from pg_event_trigger),
  (select count(*)::text from pg_proc where proname like 'tf_test_%')))
SQL
}
# Through A only: B's triggers and ticket objects are absent.
for m in $upto_b; do
  [[ "$m" == 20261124130000_delegated_owner_append ]] && break
  psql_pre -1 -f - < "supabase/migrations/$m.sql" > /dev/null
done
apply_c_pre TF953 'without migration B'
psql_pre -1 -f - < supabase/migrations/20261124130000_delegated_owner_append.sql > /dev/null
psql_pre <<< "update private.v5_write_gate set open = true" > /dev/null
apply_c_pre TF951 'with the gate open'
psql_pre <<< "update private.v5_write_gate set open = false; alter table public.events disable trigger v5_write_ticket_confirm" > /dev/null
apply_c_pre TF953 'with the AFTER ticket trigger disabled'
psql_pre <<< "alter table public.events enable trigger v5_write_ticket_confirm; grant execute on function private.v5_write_ticket_check() to service_role" > /dev/null
apply_c_pre TF955 'with EXECUTE granted on a ticket trigger function'
psql_pre <<< "revoke execute on function private.v5_write_ticket_check() from service_role; alter function private.v5_write_ticket_confirm() security invoker" > /dev/null
apply_c_pre TF954 'with a ticket trigger function not security definer'
psql_pre <<< "alter function private.v5_write_ticket_confirm() security definer" > /dev/null
fp=$(fingerprint)

# ── Trigger and function drift (Codex T210 must-fix 1): every variant runs in C's transaction ──
when_b='when (new.hash_version is not distinct from 5 or new.credential_id is not null or new.issuer_kind is not null)'
drop_bt='drop trigger zz_v5_write_ticket_check on public.events;'
drop_at='drop trigger v5_write_ticket_confirm on public.events;'
apply_c_pre TF953 'with the BEFORE trigger bound to another function' \
  "$drop_bt create trigger zz_v5_write_ticket_check before insert on public.events for each row $when_b
     execute function private.v5_write_ticket_confirm();"
apply_c_pre TF953 'with the BEFORE trigger statement-level' \
  "$drop_bt create trigger zz_v5_write_ticket_check before insert on public.events for each statement
     execute function private.v5_write_ticket_check();"
apply_c_pre TF953 'with the BEFORE trigger on INSERT OR UPDATE' \
  "$drop_bt create trigger zz_v5_write_ticket_check before insert or update on public.events for each row $when_b
     execute function private.v5_write_ticket_check();"
apply_c_pre TF953 'with the BEFORE trigger WHEN narrowed to hash_version = 5' \
  "$drop_bt create trigger zz_v5_write_ticket_check before insert on public.events for each row when (new.hash_version = 5)
     execute function private.v5_write_ticket_check();"
apply_c_pre TF953 'with the AFTER trigger a deferred constraint trigger' \
  "$drop_at create constraint trigger v5_write_ticket_confirm after insert on public.events deferrable initially deferred
     for each row $when_b execute function private.v5_write_ticket_confirm();"
apply_c_pre TF953 'with the AFTER trigger made BEFORE' \
  "$drop_at create trigger v5_write_ticket_confirm before insert on public.events for each row $when_b
     execute function private.v5_write_ticket_confirm();"
apply_c_pre TF954 'with the AFTER trigger function body replaced (still definer, empty search_path)' \
  "create or replace function private.v5_write_ticket_confirm() returns trigger language plpgsql security definer
     set search_path = '' as \$f\$ begin return null; end \$f\$;"

# ── Column grants (Codex T210 must-fix 2) ────────────────────────────────────
apply_c_pre TF955 'with a column SELECT grant on the gate to authenticated' \
  'grant select (open) on private.v5_write_gate to authenticated;'
apply_c_pre TF955 'with a column UPDATE grant on the tickets to service_role' \
  'grant update (used) on private.v5_write_tickets to service_role;'
apply_c_pre TF955 'with a column INSERT grant on the tickets to public' \
  'grant insert (txid, event_id) on private.v5_write_tickets to public;'

# ── The events lock is taken before the trigger catalog is read ─────────────
# A concurrent session disables the AFTER trigger and holds it uncommitted. C must wait on its first statement
# and then see the committed change (TF953). Had C read the catalog first, it would have passed on the stale
# catalog and dropped the CHECK with the trigger disabled.
( psql_pre <<< "begin; alter table public.events disable trigger v5_write_ticket_confirm; select pg_sleep(4); commit;" > /dev/null ) &
bg=$!
sleep 1.5
t0=$(date +%s)
set +e; out=$(psql_pre -v VERBOSITY=verbose -1 -f - < "$C" 2>&1); rc=$?; set -e
waited=$(( $(date +%s) - t0 ))
wait "$bg"
[[ $rc -ne 0 ]] && grep -q 'ERROR:  TF953:' <<< "$out" || { echo "$out" >&2; echo 'FAIL C under a concurrent trigger disable must wait and fail TF953' >&2; exit 1; }
[[ $waited -ge 2 ]] || { echo "FAIL C did not wait on the events lock (${waited}s)" >&2; exit 1; }
[[ "$(psql_pre <<< "select count(*) from pg_constraint where conname = 'events_v5_writes_disabled'")" == 1 ]] || { echo 'FAIL CHECK dropped' >&2; exit 1; }
psql_pre <<< "alter table public.events enable trigger v5_write_ticket_confirm" > /dev/null
[[ "$(fingerprint)" == "$fp" ]] || { echo 'FAIL catalog differs after the concurrency case' >&2; exit 1; }
echo "PASS C waits on the events lock (${waited}s) behind a concurrent trigger disable, then refuses (TF953); CHECK kept"

# ── Post-drop self-test failures roll the drop back (Codex T210) ────────────
apply_c_pre TF957 'with another v5 constraint not validated (fails after the drop)' \
  "do \$d\$ declare v text; begin
     select pg_get_constraintdef(oid) into v from pg_constraint where conrelid = 'public.events'::regclass and conname = 'events_v5_prev_link';
     execute 'alter table public.events drop constraint events_v5_prev_link';
     execute format('alter table public.events add constraint events_v5_prev_link %s not valid', v);
   end \$d\$;"
# Event triggers need a superuser; they fire on C's own ALTER TABLE, after the drop, inside C's transaction.
apply_c_pre TF958 'when the gate is opened after the drop (event trigger)' \
  "create function public.tf_test_open_gate() returns event_trigger language plpgsql as \$f\$
     begin update private.v5_write_gate set open = true; end \$f\$;
   create event trigger tf_test_open_gate on ddl_command_end when tag in ('ALTER TABLE') execute function public.tf_test_open_gate();" \
  supabase_admin
apply_c_pre TF956 'when the CHECK is re-added after the drop (event trigger)' \
  "create function public.tf_test_readd() returns event_trigger language plpgsql as \$f\$
     begin
       if not exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass and conname = 'events_v5_writes_disabled') then
         alter table public.events add constraint events_v5_writes_disabled check (hash_version is distinct from 5) not valid;
       end if;
     end \$f\$;
   create event trigger tf_test_readd on ddl_command_end when tag in ('ALTER TABLE') execute function public.tf_test_readd();" \
  supabase_admin
psql_pre -1 -f - < "$C" > /dev/null
echo 'PASS C applies on the restored state'
set +e; out=$(psql_pre -v VERBOSITY=verbose -1 -f - < "$C" 2>&1); rc=$?; set -e
[[ $rc -ne 0 ]] && grep -q 'ERROR:  TF952:' <<< "$out" || { echo "$out" >&2; echo 'FAIL a second C must fail with TF952' >&2; exit 1; }
echo 'PASS a second application of C fails (TF952, the CHECK is already gone)'

# ── C on the main database ──────────────────────────────────────────────────
psql_pg -1 -f - < "$C" > /dev/null
echo 'PASS C applies with its locks, preconditions (TF951-TF955) and self-test (TF956-TF958)'
got=$(psql_pg <<< "select exists (select 1 from pg_constraint where conname = 'events_v5_writes_disabled')::text || '|' ||
  (select open from private.v5_write_gate)::text || '|' ||
  (select count(*) from pg_trigger where tgrelid = 'public.events'::regclass and tgenabled = 'O'
     and tgname in ('zz_v5_write_ticket_check', 'v5_write_ticket_confirm')) || '|' ||
  (select count(*) from pg_constraint where conrelid = 'public.events'::regclass and convalidated
     and conname in ('events_credential_id_fkey', 'events_issuer_kind_check', 'events_v5_authority_pair', 'events_v5_prev_link'))")
[[ "$got" == 'false|false|2|4' ]] || { echo "FAIL catalog after C: $got" >&2; exit 1; }
echo 'PASS after C: CHECK absent, gate closed, both ticket triggers enabled, the other 4 v5 constraints validated'

owner=11111111-1111-4111-8111-111111111111
c1=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1
g1=cccccccc-0000-4000-8000-000000000001
psql_pg > /dev/null <<SQL
insert into auth.users (id, email, is_anonymous, email_confirmed_at) values
  ('$owner', 'dropcheck-owner@example.test', false, clock_timestamp());
insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy, performed_by) values
  ('$c1', '$owner', 'dropcheck c1', '["test"]', 1, 'creator');
insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, expires_at) values
  ('$g1', '$c1', '$owner', 'owner_account', repeat('a', 64), array['payment.acknowledged'], clock_timestamp() + interval '1 day');
SQL
helpers=$(cat <<SQL
create function pg_temp.reserved(p_role text) returns jsonb language sql as \$\$
  select jsonb_build_object('_actor_role', 'earner', '_role_in_agreement', p_role,
    '_auth_method', 'entry_agent_grant', '_authentication', private.v5_grant_authentication()) \$\$;
create function pg_temp.proposal(p_contract uuid, p_cred uuid, p_type text, p_payload jsonb,
    p_created_at timestamptz, p_prev text, p_key text) returns jsonb language plpgsql as \$\$
declare v_id uuid := gen_random_uuid(); v_at timestamptz := date_trunc('milliseconds', p_created_at);
begin
  return jsonb_build_object('id', v_id, 'type', p_type, 'contract_id', p_contract, 'actor_id', '$owner',
    'dod_hash', repeat('2', 64), 'created_at', to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'prev_event_hash', p_prev, 'payload', p_payload, 'payload_hash', repeat('1', 64), 'agreement_hash', null,
    'event_hash', encode(sha256(convert_to(private.v5_outer_canonical(v_id, p_type, p_contract, '$owner',
       repeat('2', 64), v_at, p_prev, repeat('1', 64), null, p_cred, 'owner_account'), 'UTF8')), 'hex'),
    'idempotency_key', p_key);
end \$\$;
create function pg_temp.append(p_contract uuid, p_cred uuid, p_hash text, p_performed_by text, p_event jsonb)
returns jsonb language sql as \$\$
  select public.append_delegated_event(p_contract, p_cred, p_hash, p_performed_by,
    jsonb_build_object('dod', '["test"]'::jsonb, 'agreement', null), p_event) \$\$;
create function pg_temp.expect(p_label text, p_expected text, p_actual text) returns void language plpgsql as \$\$
begin
  if p_actual is distinct from p_expected then raise exception 'FAIL %: expected %, got %', p_label, p_expected, p_actual; end if;
  raise notice 'PASS %', p_label;
end \$\$;
SQL
)

# A direct v5-shaped insert, with the same values every time.
direct_v5="insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, prev_event_hash,
    hash_version, payload_hash, dod_hash, credential_id, issuer_kind)
  values ('eeeeeeee-0000-4000-8000-0000000000c5', 'payment.acknowledged', '$c1', '$owner', '{}', clock_timestamp(), repeat('3', 64),
    'GENESIS', 5, repeat('1', 64), repeat('2', 64), '$g1', 'owner_account')"
ticket="insert into private.v5_write_tickets (txid, event_id) values (txid_current(), 'eeeeeeee-0000-4000-8000-0000000000c5')"
sqlstate_of() {  # $1: SQL inside a rolled-back transaction; prints the SQLSTATE of its first error, or 'stored'
  psql_pg <<SQL 2>&1 | grep -o 'OUTCOME .*' | head -1
begin;
do \$\$ declare st text; begin
  begin
    $1;
    raise notice 'OUTCOME stored';
  exception when others then get stacked diagnostics st = returned_sqlstate; raise notice 'OUTCOME %', st; end;
end \$\$;
rollback;
SQL
}
check() {  # $1 label, $2 expected outcome, $3 SQL
  local got; got=$(sqlstate_of "$3")
  [[ "$got" == "OUTCOME $2" ]] || { echo "FAIL $1: expected $2, got ${got:-nothing}" >&2; exit 1; }
  echo "PASS $1: $2"
}

# ── Closed gate, CHECK gone: the database alone refuses every v5 write ──────
psql_pg <<SQL
$helpers
select pg_temp.expect('writer, closed gate: a valid append is refused', 'gate_closed', pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator',
  pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('performer'), clock_timestamp(), 'GENESIS', 'k-closed'))->>'status');
select pg_temp.expect('writer, closed gate: no row and no ticket left', '0|0',
  (select count(*) from public.events where contract_id = '$c1') || '|' || (select count(*) from private.v5_write_tickets));
SQL
check 'direct v5 insert as postgres, closed gate, no ticket' TF011 "$direct_v5"
check 'direct v5 insert as service_role, closed gate, no ticket' TF011 "set local role service_role; $direct_v5"
check 'direct v5 insert with a ticket, closed gate: the trigger refuses on the gate' TF013 "$ticket; $direct_v5"
check 'direct v5 insert with a ticket, gate row missing' TF012 \
  "alter table private.v5_write_gate disable trigger v5_write_gate_no_delete; delete from private.v5_write_gate; $ticket; $direct_v5"
check 'authority columns without hash_version 5, closed gate, no ticket' TF011 \
  "$(sed "s/'GENESIS', 5,/'GENESIS', 4,/" <<< "$direct_v5")"

# ── Gate open (rolled back): the tickets alone refuse every unticketed v5 write
check 'gate open: direct v5 insert as postgres, no ticket' TF011 "update private.v5_write_gate set open = true; $direct_v5"
check 'gate open: direct v5 insert as service_role, no ticket' TF011 \
  "update private.v5_write_gate set open = true; set local role service_role; $direct_v5"
check 'gate open: a late BEFORE rewrite of a v4 insert into v5 is refused by the AFTER trigger' TF014 \
  "update private.v5_write_gate set open = true;
   create function pg_temp.rewrite() returns trigger language plpgsql as \$f\$
     begin new.hash_version := 5; new.credential_id := '$g1'; new.issuer_kind := 'owner_account'; return new; end \$f\$;
   create trigger zzz_test_rewrite before insert on public.events for each row execute function pg_temp.rewrite();
   insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, prev_event_hash,
       hash_version, payload_hash, dod_hash)
     values (gen_random_uuid(), 'payment.acknowledged', '$c1', '$owner', '{}', clock_timestamp(), repeat('3', 64), 'GENESIS',
       4, repeat('1', 64), repeat('2', 64))"

# ── What must still work after C ────────────────────────────────────────────
check 'a v4 insert without authority columns is stored (closed gate)' stored \
  "insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, prev_event_hash,
       hash_version, payload_hash, dod_hash)
     values (gen_random_uuid(), 'payment.acknowledged', '$c1', '$owner', '{}', clock_timestamp(), repeat('3', 64), 'GENESIS',
       4, repeat('1', 64), repeat('2', 64))"
psql_pg <<SQL
$helpers
begin;
update private.v5_write_gate set open = true;
do \$\$ declare r jsonb; e jsonb; begin
  e := pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('performer'), clock_timestamp(), 'GENESIS', 'k-open');
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator', e);
  perform pg_temp.expect('gate open (rolled back): the writer appends with no CHECK in the way', 'appended', r->>'status');
  perform pg_temp.expect('the stored row is v5 with the grant authority and its ticket is consumed', '5|$g1|0',
    (select hash_version || '|' || credential_id from public.events where id = (e->>'id')::uuid) || '|' ||
    (select count(*) from private.v5_write_tickets));
end \$\$;
rollback;
SQL

# ── Legacy writers cannot write v5: no ticket (T234) ─────────────────────────
# A complete v5-shaped event with a real live grant through each generic legacy
# writer, as service_role. With the CHECK dropped and the gate open, the ticket
# trigger refuses with exactly TF011, with the gate closed and with it open.
c5=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5
c6=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6
psql_pg > /dev/null <<SQL
create schema tf_legacy;
create function tf_legacy.tip(c text) returns text language sql stable as \$\$
  select coalesce((select event_hash from public.events where contract_id = c and event_hash is not null
                   order by created_at desc, id desc limit 1), 'GENESIS') \$\$;
create function tf_legacy.ev(c text, typ text, actor text, prev text, extra jsonb default '{}') returns jsonb
  language sql volatile as \$\$
  select jsonb_build_object('id', gen_random_uuid(), 'type', typ, 'contract_id', c, 'actor_id', actor,
    'payload', '{}'::jsonb, 'created_at', clock_timestamp(), 'event_hash', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
    'prev_event_hash', prev, 'hash_version', 4, 'payload_hash', repeat('1', 64),
    'agreement_hash', repeat('2', 64), 'dod_hash', repeat('3', 64)) || extra \$\$;
grant usage on schema tf_legacy to service_role;
grant execute on all functions in schema tf_legacy to service_role;
insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy, invited_hirer_email, invite_token, invite_token_expires_at) values
  ('$c5', '$owner', 'legacy c5', '["seed"]', 1, 'guest5@example.test', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', clock_timestamp() + interval '1 day'),
  ('$c6', '$owner', 'legacy c6', '["seed"]', 1, 'guest6@example.test', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6', clock_timestamp() + interval '1 day');
insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, expires_at) values
  ('cccccccc-0000-4000-8000-000000000006', '$c5', '$owner', 'owner_account', repeat('6', 64), array['payment.acknowledged'], clock_timestamp() + interval '1 day'),
  ('cccccccc-0000-4000-8000-000000000007', '$c6', '$owner', 'owner_account', repeat('7', 64), array['payment.acknowledged'], clock_timestamp() + interval '1 day');
set role service_role;
do \$\$ declare r jsonb; xv text; begin
  select xmin::text into xv from public.contracts where id = '$c5';
  r := public.accept_invitation('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', 'guest5@example.test',
         'cccccccc-cccc-4ccc-8ccc-ccccccccccc5', clock_timestamp() + interval '1 day', xv, 'GENESIS',
         tf_legacy.ev('$c5', 'contract.accepted', 'guest:guest5@example.test', 'GENESIS'));
  if r->>'status' <> 'accepted' then raise exception 'seed accept: %', r; end if;
end \$\$;
reset role;
SQL
legacy_v5() {  # $1: the preamble (opened or CHECK present); prints one outcome per writer
  psql_pg <<SQL
$1
set local role service_role;
do \$\$
declare r jsonb; xv text; st text; cn text; outcome text; before_ev text; after_ev text; before_ct text; after_ct text;
  v5 jsonb := jsonb_build_object('hash_version', 5, 'issuer_kind', 'owner_account', 'prev_event_hash', 'GENESIS');
begin
  select md5(coalesce(string_agg(to_jsonb(e)::text, '|' order by id), '')) into before_ev from public.events e where contract_id in ('$c5', '$c6');
  select md5(string_agg(to_jsonb(c)::text, '|' order by id)) into before_ct from public.contracts c where id in ('$c5', '$c6');
  -- append_guest_event
  begin
    r := public.append_guest_event('$c5', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc5', tf_legacy.tip('$c5'),
      tf_legacy.ev('$c5', 'rating.submitted', 'guest:guest5@example.test', tf_legacy.tip('$c5'),
        v5 || jsonb_build_object('credential_id', 'cccccccc-0000-4000-8000-000000000006', 'prev_event_hash', tf_legacy.tip('$c5'))));
    outcome := 'returned ' || r::text;
  exception when others then get stacked diagnostics st = returned_sqlstate; outcome := st; end;
  raise notice 'LEGACY append_guest_event %', outcome;
  -- reissue_guest_access
  begin
    r := public.reissue_guest_access('$c5', '$owner', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9', clock_timestamp() + interval '1 day',
      tf_legacy.tip('$c5'), tf_legacy.ev('$c5', 'access.reissued', 'owner', tf_legacy.tip('$c5'),
        v5 || jsonb_build_object('credential_id', 'cccccccc-0000-4000-8000-000000000006', 'prev_event_hash', tf_legacy.tip('$c5'))));
    outcome := 'returned ' || r::text;
  exception when others then get stacked diagnostics st = returned_sqlstate; outcome := st; end;
  raise notice 'LEGACY reissue_guest_access %', outcome;
  -- accept_invitation
  select xmin::text into xv from public.contracts where id = '$c6';
  begin
    r := public.accept_invitation('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6', 'guest6@example.test',
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc6', clock_timestamp() + interval '1 day', xv, 'GENESIS',
      tf_legacy.ev('$c6', 'contract.accepted', 'guest:guest6@example.test', 'GENESIS',
        v5 || jsonb_build_object('credential_id', 'cccccccc-0000-4000-8000-000000000007')));
    outcome := 'returned ' || r::text;
  exception when others then get stacked diagnostics st = returned_sqlstate; outcome := st; end;
  raise notice 'LEGACY accept_invitation %', outcome;
  select md5(coalesce(string_agg(to_jsonb(e)::text, '|' order by id), '')) into after_ev from public.events e where contract_id in ('$c5', '$c6');
  select md5(string_agg(to_jsonb(c)::text, '|' order by id)) into after_ct from public.contracts c where id in ('$c5', '$c6');
  raise notice 'LEGACY unchanged %', (before_ev = after_ev and before_ct = after_ct)::text;
end \$\$;
rollback;
SQL
}
for preamble in "begin; update private.v5_write_gate set open = true;" "begin;"; do
  label=$([[ "$preamble" == "begin;" ]] && echo 'after C, gate closed' || echo 'after C, gate open')
  got=$(legacy_v5 "$preamble" 2>&1 | grep -o 'LEGACY .*' | tr '\n' ';')
  want='LEGACY append_guest_event TF011;LEGACY reissue_guest_access TF011;LEGACY accept_invitation TF011;LEGACY unchanged true;'
  [[ "$got" == "$want" ]] || { echo "FAIL legacy writers ($label): $got" >&2; exit 1; }
  echo "PASS legacy writers with a v5-shaped event and a real grant ($label): exactly TF011 each; events and contracts unchanged"
done

end=$(psql_pg <<< "select (select open from private.v5_write_gate)::text || '|' || (select count(*) from public.events where hash_version = 5 or credential_id is not null) || '|' || (select count(*) from private.v5_write_tickets)")
[[ "$end" == 'false|0|0' ]] || { echo "FAIL after the suite: $end" >&2; exit 1; }
echo 'PASS after the suite: gate closed, no v5 or authority row, no ticket'
echo 'ALL PASS'
