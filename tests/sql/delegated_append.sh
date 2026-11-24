#!/usr/bin/env bash
# Disposable local-only evidence for 20261124130000_delegated_owner_append (row
# 4b, docs/plans/row4-owner-append.md §4b/§4c). Requires the trustflow-localdb
# container; never targets a URL, never a hosted project.
#
# Fixture: the same fail-closed schema-only restore as
# tests/sql/events_v5_authority.sh (owners and ACLs kept, only the 7 reviewed
# platform event triggers left out), then the migrations up to today's head and
# the resolver migration. No event is written: the resolver only reads.
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${TF_FIXTURE_CONTAINER:-trustflow-localdb}"
db="trustflow_delegated_$$"
dump="/tmp/${db}.dump"
work="$(mktemp -d "${TMPDIR:-/tmp}/trustflowdelegated.XXXXXX")"
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
echo 'fixture: applying migrations to head, the resolver and the writer'
for m in 20261118214020_entry_agent_credentials 20261120090000_create_entry_contract \
         20261120180000_close_contract_client_insert 20261122130000_events_v5_authority_columns \
         20261124120000_entry_agent_resolver 20261124130000_delegated_owner_append; do
  psql_pg -1 -f - < "supabase/migrations/$m.sql" > /dev/null
done
echo 'PASS both migrations apply with their self-tests (TF921-TF923, TF931-TF934)'

owner=11111111-1111-4111-8111-111111111111
c1=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1   # performed_by creator: the owner performs
c2=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2   # performed_by counterparty: the owner receives
g1=cccccccc-0000-4000-8000-000000000001
g2=cccccccc-0000-4000-8000-000000000002   # a second grant of the same owner on c1
g3=cccccccc-0000-4000-8000-000000000003   # on c2
psql_pg > /dev/null <<SQL
insert into auth.users (id, email, is_anonymous, email_confirmed_at) values
  ('$owner', 'delegated-owner@example.test', false, clock_timestamp());
insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy, performed_by) values
  ('$c1', '$owner', 'delegated c1', '["test"]', 1, 'creator'),
  ('$c2', '$owner', 'delegated c2', '["test"]', 1, 'counterparty');
insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, expires_at) values
  ('$g1', '$c1', '$owner', 'owner_account', repeat('a', 64),
   array['payment.acknowledged', 'payment.reported', 'performance.asserted'], clock_timestamp() + interval '1 day'),
  ('$g2', '$c1', '$owner', 'owner_account', repeat('b', 64), array['payment.acknowledged'], clock_timestamp() + interval '1 day'),
  ('$g3', '$c2', '$owner', 'owner_account', repeat('c', 64), array['payment.reported'], clock_timestamp() + interval '1 day');
SQL

# Shared per-session helpers. A proposal is built the way log-event builds it:
# fixed inner digests (SQL does not prove them, by design), the outer hash over
# the v5 canonical, and the four reserved fields Edge predicts.
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

# ── Pure helpers ────────────────────────────────────────────────────────────
psql_pg <<SQL
$helpers
-- The created-at window, at its exact bounds.
select pg_temp.expect('window: now - 60 s passes', 'true', private.v5_created_at_ok('2026-11-24 12:00:00+00'::timestamptz - interval '60 seconds', '2026-11-24 12:00:00+00', null)::text);
select pg_temp.expect('window: 1 us older fails', 'false', private.v5_created_at_ok('2026-11-24 12:00:00+00'::timestamptz - interval '60.000001 seconds', '2026-11-24 12:00:00+00', null)::text);
select pg_temp.expect('window: now passes', 'true', private.v5_created_at_ok('2026-11-24 12:00:00+00', '2026-11-24 12:00:00+00', null)::text);
select pg_temp.expect('window: 1 us later fails', 'false', private.v5_created_at_ok('2026-11-24 12:00:00.000001+00', '2026-11-24 12:00:00+00', null)::text);
select pg_temp.expect('window: equal to the tip fails', 'false', private.v5_created_at_ok('2026-11-24 11:59:59+00', '2026-11-24 12:00:00+00', '2026-11-24 11:59:59+00')::text);
-- Reserved-field classification, in isolation (Codex T191 should-fix 1).
select pg_temp.expect('reserved: well-formed and fresh', 'ok', private.v5_reserved_fields_status(pg_temp.reserved('performer'), 'creator', 'creator'));
select pg_temp.expect('reserved: counterparty proposal gives receiver', 'ok', private.v5_reserved_fields_status(pg_temp.reserved('receiver'), 'counterparty', 'counterparty'));
select pg_temp.expect('reserved: stale proposal', 'context_changed', private.v5_reserved_fields_status(pg_temp.reserved('receiver'), 'counterparty', 'creator'));
select pg_temp.expect('reserved: wrong role with current context', 'reserved_fields_mismatch', private.v5_reserved_fields_status(pg_temp.reserved('receiver'), 'creator', 'creator'));
select pg_temp.expect('reserved: fixed-field error with stale context', 'reserved_fields_mismatch', private.v5_reserved_fields_status(pg_temp.reserved('receiver') || '{"_auth_method":"account_session"}', 'counterparty', 'creator'));
select pg_temp.expect('reserved: proposal outside the domain', 'reserved_fields_mismatch', private.v5_reserved_fields_status(pg_temp.reserved('performer'), 'earner', 'creator'));
select pg_temp.expect('reserved: missing field', 'reserved_fields_mismatch', private.v5_reserved_fields_status(pg_temp.reserved('performer') - '_actor_role', 'creator', 'creator'));
select pg_temp.expect('reserved: extra top-level _ key', 'reserved_fields_mismatch', private.v5_reserved_fields_status(pg_temp.reserved('performer') || '{"_extra":1}', 'creator', 'creator'));
select pg_temp.expect('reserved: wrong _actor_role', 'reserved_fields_mismatch', private.v5_reserved_fields_status(pg_temp.reserved('performer') || '{"_actor_role":"guest_hirer"}', 'creator', 'creator'));
select pg_temp.expect('reserved: _authentication inner value changed', 'reserved_fields_mismatch', private.v5_reserved_fields_status(jsonb_set(pg_temp.reserved('performer'), '{_authentication,assurance}', '"account_session"'), 'creator', 'creator'));
select pg_temp.expect('reserved: _authentication inner key added', 'reserved_fields_mismatch', private.v5_reserved_fields_status(jsonb_set(pg_temp.reserved('performer'), '{_authentication,extra}', 'true'), 'creator', 'creator'));
select pg_temp.expect('reserved: nested _ keys are party data', 'ok', private.v5_reserved_fields_status(pg_temp.reserved('performer') || '{"note":{"_x":1}}', 'creator', 'creator'));
-- Outer canonical parity: the exact string tests/unit/delegatedEvent.test.js pins for buildEventCanonicalV5.
select pg_temp.expect('outer canonical matches the pinned TS vector',
  '{"domain":"trustflow.event","hash_version":5,"id":"11111111-2222-4333-8444-555555555555","type":"payment.acknowledged","contract_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1","actor_id":"11111111-1111-4111-8111-111111111111","dod_hash":"$(printf '2%.0s' {1..64})","created_at":"2026-11-24T12:00:00.123Z","prev_hash":"GENESIS","payload_hash":"$(printf '1%.0s' {1..64})","agreement_hash":null,"credential_id":"cccccccc-0000-4000-8000-000000000001","issuer_kind":"owner_account"}',
  private.v5_outer_canonical('11111111-2222-4333-8444-555555555555', 'payment.acknowledged', '$c1', '$owner', repeat('2', 64),
    '2026-11-24T12:00:00.123Z', 'GENESIS', repeat('1', 64), null, '$g1', 'owner_account'));
SQL

# ── The writer, with v5 still closed ────────────────────────────────────────
psql_pg <<SQL
$helpers
select pg_temp.expect('closed gate refuses a valid append', 'gate_closed', pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator',
  pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('performer'), clock_timestamp(), 'GENESIS', 'k-closed'))->>'status');
select pg_temp.expect('no row written while closed', '0', (select count(*)::text from public.events where contract_id = '$c1'));
do \$\$ declare v_role text; begin
  foreach v_role in array array['anon', 'authenticated'] loop
    execute format('set local role %I', v_role);
    if current_user is distinct from v_role then raise exception 'FAIL role switch'; end if;
    begin
      perform public.append_delegated_event('$c1', '$g1', repeat('a', 64), 'creator', '{}', '{}');
      raise exception 'FAIL % executed append_delegated_event', v_role;
    exception when insufficient_privilege then null; end;
    begin
      perform public.replay_delegated_event('$c1', '$g1', repeat('a', 64), 'payment.acknowledged', 'k');
      raise exception 'FAIL % executed replay_delegated_event', v_role;
    exception when insufficient_privilege then null; end;
    reset role;
  end loop;
  raise notice 'PASS anon and authenticated get 42501 on both RPCs';
  execute 'set local role service_role';
  if current_user is distinct from 'service_role' then raise exception 'FAIL role switch'; end if;
  if public.replay_delegated_event('$c1', '$g1', repeat('a', 64), 'payment.acknowledged', 'k-none')->>'status' <> 'none' then
    raise exception 'FAIL service_role replay';
  end if;
  reset role;
  raise notice 'PASS service_role executes replay_delegated_event';
end \$\$;
SQL

# ── The writer, opened inside rolled-back transactions ──────────────────────
open_tx="begin; alter table public.events drop constraint events_v5_writes_disabled; update private.v5_write_gate set open = true;"
psql_pg <<SQL
$helpers
$open_tx
do \$\$
declare r jsonb; e jsonb; v_first jsonb; v_row public.events%rowtype;
begin
  e := pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('performer') || '{"note":"paid"}', clock_timestamp(), 'GENESIS', 'k1');
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator', e);
  perform pg_temp.expect('a valid grant appends', 'appended', r->>'status');
  v_first := r->'event';
  select * into v_row from public.events where id = (e->>'id')::uuid;
  perform pg_temp.expect('stored as v5 with the grant authority', '5|$g1|owner_account|$owner',
    v_row.hash_version || '|' || v_row.credential_id || '|' || v_row.issuer_kind || '|' || v_row.actor_id);
  perform pg_temp.expect('stored payload is the final tree', (e->'payload')::text, v_row.payload::text);
  perform pg_temp.expect('the ticket is consumed', '0', (select count(*)::text from private.v5_write_tickets));
  perform pg_temp.expect('stored hash recomputes over the stored row', v_row.event_hash,
    encode(sha256(convert_to(private.v5_outer_canonical(v_row.id, v_row.type, v_row.contract_id::uuid, v_row.actor_id::uuid,
      v_row.dod_hash, v_row.created_at, v_row.prev_event_hash, v_row.payload_hash, v_row.agreement_hash,
      v_row.credential_id, v_row.issuer_kind), 'UTF8')), 'hex'));

  -- Replay is bound to the grant.
  r := public.replay_delegated_event('$c1', '$g1', repeat('a', 64), 'payment.acknowledged', 'k1');
  perform pg_temp.expect('same grant replays the original', v_first->>'id', r->'event'->>'id');
  r := public.replay_delegated_event('$c1', '$g2', repeat('b', 64), 'payment.acknowledged', 'k1');
  perform pg_temp.expect('another grant of the same owner collides', 'idempotency_key_in_use', r->>'status');
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator',
    pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('performer'), clock_timestamp(), v_row.event_hash, 'k1'));
  perform pg_temp.expect('append twin under the lock replays', 'replayed|' || (v_first->>'id'), (r->>'status') || '|' || (r->'event'->>'id'));
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator',
    pg_temp.proposal('$c1', '$g1', 'performance.asserted', pg_temp.reserved('performer'), clock_timestamp(), v_row.event_hash, 'k1'));
  perform pg_temp.expect('same key, other operation collides', 'idempotency_key_in_use', r->>'status');

  -- Refusals: nothing is written, no ticket is left.
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator',
    pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('performer'), clock_timestamp(), 'GENESIS', 'k2'));
  perform pg_temp.expect('wrong prev gives chain_conflict', 'chain_conflict', r->>'status');
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator',
    pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('performer'), clock_timestamp() - interval '61 seconds', v_row.event_hash, 'k2'));
  perform pg_temp.expect('a stamp outside the window gives clock_window', 'clock_window', r->>'status');
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator',
    pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('receiver'), clock_timestamp(), v_row.event_hash, 'k2'));
  perform pg_temp.expect('wrong reserved role gives reserved_fields_mismatch', 'reserved_fields_mismatch', r->>'status');
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'counterparty',
    pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('receiver'), clock_timestamp(), v_row.event_hash, 'k2'));
  perform pg_temp.expect('stale performed_by proposal gives context_changed', 'context_changed', r->>'status');
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator',
    pg_temp.proposal('$c1', '$g1', 'payment.reported', pg_temp.reserved('performer'), clock_timestamp(), v_row.event_hash, 'k2'));
  perform pg_temp.expect('a type the locked role may not write', 'wrong_party_for_event_type', r->>'status');
  r := pg_temp.append('$c1', '$g2', repeat('b', 64), 'creator',
    pg_temp.proposal('$c1', '$g2', 'payment.reported', pg_temp.reserved('performer'), clock_timestamp(), v_row.event_hash, 'k2'));
  perform pg_temp.expect('a type outside the grant', 'scope', r->>'status');
  r := pg_temp.append('$c1', '$g1', repeat('9', 64), 'creator',
    pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('performer'), clock_timestamp(), v_row.event_hash, 'k2'));
  perform pg_temp.expect('a wrong secret', 'secret_mismatch', r->>'status');
  e := pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('performer'), clock_timestamp(), v_row.event_hash, 'k2');
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator', jsonb_set(e, '{event_hash}', to_jsonb(repeat('0', 64))));
  perform pg_temp.expect('a wrong outer hash gives binding_mismatch', 'binding_mismatch', r->>'status');
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator', e || jsonb_build_object('credential_id', '$g2'));
  perform pg_temp.expect('a body authority field gives binding_mismatch', 'binding_mismatch', r->>'status');
  r := pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator', jsonb_set(e, '{actor_id}', to_jsonb(gen_random_uuid()::text)));
  perform pg_temp.expect('another actor gives binding_mismatch', 'binding_mismatch', r->>'status');
  r := public.append_delegated_event('$c1', '$g1', repeat('a', 64), 'creator', jsonb_build_object('dod', '["other"]'::jsonb, 'agreement', null), e);
  perform pg_temp.expect('DoD inputs unlike the locked DoD give context_changed', 'context_changed', r->>'status');
  r := public.append_delegated_event('$c1', '$g1', repeat('a', 64), 'creator', jsonb_build_object('dod', '["test"]'::jsonb, 'agreement', '{}'::jsonb), e);
  perform pg_temp.expect('agreement inputs on a draft give context_changed', 'context_changed', r->>'status');
  perform pg_temp.expect('refusals wrote nothing and left no ticket', '1|0',
    (select count(*) from public.events where contract_id = '$c1') || '|' || (select count(*) from private.v5_write_tickets));

  -- The other performed_by direction: the owner receives on c2.
  r := pg_temp.append('$c2', '$g3', repeat('c', 64), 'counterparty',
    pg_temp.proposal('$c2', '$g3', 'payment.reported', pg_temp.reserved('receiver'), clock_timestamp(), 'GENESIS', null));
  perform pg_temp.expect('counterparty-performed deal: the owner records as receiver', 'appended', r->>'status');
end \$\$;
rollback;
SQL

# ── Ticket enforcement, with the CHECK dropped and the gate open ────────────
psql_pg <<SQL
$helpers
$open_tx
do \$\$
declare v_role text;
begin
  -- A direct v5 insert, as the owner and as service_role: the ticket SQLSTATE,
  -- not 42501 or a constraint error.
  foreach v_role in array array['postgres', 'service_role'] loop
    execute format('set local role %I', v_role);
    begin
      insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, prev_event_hash,
          hash_version, payload_hash, dod_hash, credential_id, issuer_kind)
      values (gen_random_uuid(), 'payment.acknowledged', '$c1', '$owner', '{}', clock_timestamp(), repeat('3', 64), 'GENESIS',
          5, repeat('1', 64), repeat('2', 64), '$g1', 'owner_account');
      raise exception 'FAIL direct v5 insert as % stored', v_role;
    exception when sqlstate 'TF011' then null; end;
    reset role;
  end loop;
  raise notice 'PASS direct v5 inserts as postgres and service_role get TF011 (no ticket)';
end \$\$;
rollback;
SQL
if [[ "$(psql_pg <<< "select has_table_privilege('service_role', 'public.events', 'INSERT')")" != t ]]; then
  echo 'NOTE service_role holds no INSERT on events here; its direct-insert case is refused by privilege before the trigger' >&2
fi

# A later-sorting BEFORE trigger that rewrites a legacy insert into an otherwise
# constraint-valid v5 row: the AFTER trigger refuses it with its own SQLSTATE.
psql_pg <<SQL
$helpers
begin;
alter table public.events drop constraint events_v5_writes_disabled;
update private.v5_write_gate set open = true;
create function pg_temp.rewrite() returns trigger language plpgsql as \$\$
begin new.hash_version := 5; new.credential_id := '$g1'; new.issuer_kind := 'owner_account'; return new; end \$\$;
create trigger zzz_test_rewrite before insert on public.events for each row execute function pg_temp.rewrite();
do \$\$
declare v_id uuid := gen_random_uuid();
begin
  begin
    insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, prev_event_hash,
        hash_version, payload_hash, dod_hash)
    values (v_id, 'payment.acknowledged', '$c1', '$owner', '{}', clock_timestamp(), repeat('3', 64), 'GENESIS',
        4, repeat('1', 64), repeat('2', 64));
    raise exception 'FAIL the rewritten row was stored';
  exception when sqlstate 'TF014' then null; end;
  if exists (select 1 from public.events where id = v_id) then raise exception 'FAIL rewritten row present'; end if;
  raise notice 'PASS a late BEFORE rewrite into v5 is refused by the AFTER trigger with TF014; no row';
end \$\$;
rollback;
SQL

# A trigger that alters a returned field: the RETURNING comparison rolls back.
psql_pg <<SQL
$helpers
$open_tx
create function pg_temp.alter_payload() returns trigger language plpgsql as \$\$
begin new.payload := new.payload || '{"tampered":true}'; return new; end \$\$;
create trigger aaa_test_alter before insert on public.events for each row execute function pg_temp.alter_payload();
do \$\$
declare e jsonb := pg_temp.proposal('$c1', '$g1', 'payment.acknowledged', pg_temp.reserved('performer'), clock_timestamp(), 'GENESIS', 'k-alter');
begin
  begin
    perform pg_temp.append('$c1', '$g1', repeat('a', 64), 'creator', e);
    raise exception 'FAIL an altered row was returned as appended';
  exception when sqlstate 'TF010' then null; end;
  if exists (select 1 from public.events where id = (e->>'id')::uuid) then raise exception 'FAIL altered row present'; end if;
  raise notice 'PASS a trigger that alters the stored row makes the writer raise TF010; no row';
end \$\$;
rollback;
SQL

expect_closed=$(psql_pg <<< "select (select open from private.v5_write_gate)::text || '|' || exists (select 1 from pg_constraint where conname = 'events_v5_writes_disabled')::text || '|' || (select count(*) from public.events where hash_version = 5)")
[[ "$expect_closed" == 'false|true|0' ]] || { echo "FAIL after the suite: $expect_closed" >&2; exit 1; }
echo 'PASS after the suite: gate closed, CHECK present, no v5 row'

psql_pg < tests/sql/entry_agent_credentials_inventory.sql > "$work/inventory.out" 2>&1
grep -i 'fail\|error' "$work/inventory.out" && { echo 'inventory reported a failure' >&2; exit 1; }
echo 'PASS bypass inventory with the writer present'
echo 'ALL PASS'
