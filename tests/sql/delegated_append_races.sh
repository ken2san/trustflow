#!/usr/bin/env bash
# Disposable local-only two-session races for append_delegated_event (row 4b,
# docs/plans/row4-owner-append.md §4b "Revoke and expiry timing" and
# "Concurrency"). Requires the trustflow-localdb container; never targets a URL,
# never a hosted project.
#
# Fixture: the same fail-closed schema-only restore as
# tests/sql/events_v5_authority.sh (owners and ACLs kept, only the 7 reviewed
# platform event triggers left out), then the migrations up to today's head and
# the resolver migration. No event is written: the resolver only reads.
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${TF_FIXTURE_CONTAINER:-trustflow-localdb}"
db="trustflow_delraces_$$"
dump="/tmp/${db}.dump"
work="$(mktemp -d "${TMPDIR:-/tmp}/trustflowdelraces.XXXXXX")"
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
c5=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5   # a guest deal, for the guest-writer race
psql_pg > /dev/null <<SQL
alter table public.events drop constraint events_v5_writes_disabled;
update private.v5_write_gate set open = true;
insert into auth.users (id, email, is_anonymous, email_confirmed_at) values
  ('$owner', 'races-owner@example.test', false, clock_timestamp());
insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy, performed_by, invited_hirer_email,
    invite_token, invite_token_expires_at) values
  ('$c1', '$owner', 'races c1', '["test"]', 1, 'creator', null, null, null),
  ('$c5', '$owner', 'races c5', '["test"]', 1, 'creator', 'guest5@example.test',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', clock_timestamp() + interval '1 day');
-- Shared helpers, callable from every session.
create schema tf_race;
create function tf_race.tip(c uuid) returns text language sql stable as \$\$
  select coalesce((select event_hash from public.events where contract_id = c::text and event_hash is not null
                   order by created_at desc, id desc limit 1), 'GENESIS') \$\$;
create function tf_race.reserved() returns jsonb language sql as \$\$
  select jsonb_build_object('_actor_role', 'earner', '_role_in_agreement', 'performer',
    '_auth_method', 'entry_agent_grant', '_authentication', private.v5_grant_authentication()) \$\$;
-- A proposal built now, on the tip as read now, as log-event would build it.
create function tf_race.append(p_contract uuid, p_cred uuid, p_hash text, p_key text) returns jsonb language plpgsql as \$\$
declare v_id uuid := gen_random_uuid(); v_at timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_prev text := tf_race.tip(p_contract); v_type text := 'payment.acknowledged';
begin
  return public.append_delegated_event(p_contract, p_cred, p_hash, 'creator', '{"dod":["test"],"agreement":null}',
    jsonb_build_object('id', v_id, 'type', v_type, 'contract_id', p_contract, 'actor_id', '$owner',
      'dod_hash', repeat('2', 64), 'created_at', to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'prev_event_hash', v_prev, 'payload', tf_race.reserved(), 'payload_hash', repeat('1', 64), 'agreement_hash', null,
      'event_hash', encode(sha256(convert_to(private.v5_outer_canonical(v_id, v_type, p_contract, '$owner',
         repeat('2', 64), v_at, v_prev, repeat('1', 64), null, p_cred, 'owner_account'), 'UTF8')), 'hex'),
      'idempotency_key', p_key));
end \$\$;
create function tf_race.grant(p_id uuid, p_contract uuid, p_hash text, p_ttl interval) returns void language sql as \$\$
  insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, expires_at)
  values (p_id, p_contract, '$owner', 'owner_account', p_hash, array['payment.acknowledged'], clock_timestamp() + p_ttl) \$\$;
-- The guest deal is accepted through the real legacy writer, so the guest can write.
create function tf_race.ev(c uuid, typ text, actor text, prev text) returns jsonb language sql volatile as \$\$
  select jsonb_build_object('id', gen_random_uuid(), 'type', typ, 'contract_id', c, 'actor_id', actor,
    'payload', '{}'::jsonb, 'created_at', clock_timestamp(), 'event_hash', encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
    'prev_event_hash', prev, 'hash_version', 4, 'payload_hash', repeat('1', 64),
    'agreement_hash', repeat('2', 64), 'dod_hash', repeat('3', 64)) \$\$;
do \$\$ declare r jsonb; xv text; begin
  select xmin::text into xv from public.contracts where id = '$c5';
  r := public.accept_invitation('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', 'guest5@example.test',
         'cccccccc-cccc-4ccc-8ccc-ccccccccccc5', clock_timestamp() + interval '1 day', xv, 'GENESIS',
         tf_race.ev('$c5', 'contract.accepted', 'guest:guest5@example.test', 'GENESIS'));
  if r->>'status' <> 'accepted' then raise exception 'seed accept: %', r; end if;
end \$\$;
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
status_of() { grep -oE '"status": ?"[a-z_]+"' "$work/$1" | head -1 | sed -E 's/.*"([a-z_]+)"$/\1/'; }
rows_of() { q "select count(*) from public.events where credential_id = '$1'"; }

# 1. Revoke first: the append waits on the contract lock revoke holds, then is refused.
g=cccccccc-0000-4000-8000-0000000000b1
q "select tf_race.grant('$g', '$c1', repeat('1', 64), interval '1 day')" > /dev/null
start_keeper; start_holder "select public.revoke_entry_agent_credential('$c1', '$g', '$owner')"
bg rk_waiter "select tf_race.append('$c1', '$g', repeat('1', 64), 'r1')"; waiter=$!
blocked_by_holder rk_waiter
release; wait "$waiter"
expect 'revoke first: the waiting append is refused revoked' revoked "$(status_of rk_waiter)"
expect 'revoke first: nothing written' 0 "$(rows_of "$g")"

# 2. Append first: revoke waits for it; the admitted append completes; afterwards
#    nothing is admitted, a replay of the same key included.
g=cccccccc-0000-4000-8000-0000000000b2
q "select tf_race.grant('$g', '$c1', repeat('2', 64), interval '1 day')" > /dev/null
start_keeper; start_holder "select tf_race.append('$c1', '$g', repeat('2', 64), 'r2')"
bg rk_revoker "select public.revoke_entry_agent_credential('$c1', '$g', '$owner')"; revoker=$!
blocked_by_holder rk_revoker
release; wait "$revoker"
expect 'append first: the admitted append commits' appended "$(status_of rk_holder)"
expect 'append first: revoke completes after it' revoked "$(status_of rk_revoker)"
expect 'append first: exactly one row under the grant' 1 "$(rows_of "$g")"
expect 'after revoke: a same-grant replay is refused' revoked \
  "$(q "select public.replay_delegated_event('$c1', '$g', repeat('2', 64), 'payment.acknowledged', 'r2')->>'status'")"
expect 'after revoke: a fresh append is refused' revoked "$(q "select tf_race.append('$c1', '$g', repeat('2', 64), 'r2b')->>'status'")"

# 3. Expiry while the writer waits on the contract lock.
g=cccccccc-0000-4000-8000-0000000000b3
q "select tf_race.grant('$g', '$c1', repeat('3', 64), interval '3 seconds')" > /dev/null
start_keeper; start_holder "select id from public.contracts where id = '$c1' for update"
bg rk_waiter "select tf_race.append('$c1', '$g', repeat('3', 64), null)"; waiter=$!
blocked_by_holder rk_waiter
expect 'expiry: grant live while the append is blocked' t "$(q "select expires_at > clock_timestamp() from public.entry_agent_credentials where id = '$g'")"
until_true 'grant expired' "select expires_at <= clock_timestamp() from public.entry_agent_credentials where id = '$g'"
release; wait "$waiter"
expect 'expiry during the writer wait: refused expired' expired "$(status_of rk_waiter)"
expect 'expiry: nothing written' 0 "$(rows_of "$g")"

# 4. An owner-path (v4) insert holds the contract lock: the delegated append,
#    built on the old tip, loses the chain and a rebuilt one appends.
g=cccccccc-0000-4000-8000-0000000000b4
q "select tf_race.grant('$g', '$c1', repeat('4', 64), interval '1 day')" > /dev/null
start_keeper
start_holder "insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, prev_event_hash, hash_version, payload_hash, dod_hash, agreement_hash) select gen_random_uuid(), 'payment.reported', '$c1', '$owner', '{}', clock_timestamp(), encode(sha256(gen_random_uuid()::text::bytea), 'hex'), tf_race.tip('$c1'), 4, repeat('1', 64), repeat('2', 64), repeat('3', 64)"
bg rk_waiter "select tf_race.append('$c1', '$g', repeat('4', 64), null)"; waiter=$!
blocked_by_holder rk_waiter
release; wait "$waiter"
expect 'owner insert holds the deal: the delegated append gets chain_conflict' chain_conflict "$(status_of rk_waiter)"
expect 'a rebuilt delegated append then lands' appended "$(q "select tf_race.append('$c1', '$g', repeat('4', 64), null)->>'status'")"

# 5. A guest write holds the deal: the same answer.
g=cccccccc-0000-4000-8000-0000000000b5
q "select tf_race.grant('$g', '$c5', repeat('5', 64), interval '1 day')" > /dev/null
start_keeper
start_holder "select public.append_guest_event('$c5', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc5', tf_race.tip('$c5'), tf_race.ev('$c5', 'rating.submitted', 'guest:guest5@example.test', tf_race.tip('$c5')))"
bg rk_waiter "select tf_race.append('$c5', '$g', repeat('5', 64), null)"; waiter=$!
blocked_by_holder rk_waiter
release; wait "$waiter"
expect 'guest write holds the deal: the holder appended' appended "$(status_of rk_holder)"
expect 'guest write holds the deal: the delegated append gets chain_conflict' chain_conflict "$(status_of rk_waiter)"

# 6. Two delegated appends with one key: the second waits, then gets the first's row.
g=cccccccc-0000-4000-8000-0000000000b6
q "select tf_race.grant('$g', '$c1', repeat('6', 64), interval '1 day')" > /dev/null
start_keeper; start_holder "select tf_race.append('$c1', '$g', repeat('6', 64), 'same-key')"
bg rk_waiter "select tf_race.append('$c1', '$g', repeat('6', 64), 'same-key')"; waiter=$!
blocked_by_holder rk_waiter
release; wait "$waiter"
first=$(grep -oE '"id": ?"[0-9a-f-]{36}"' "$work/rk_holder" | head -1)
[[ -n "$first" ]] || { echo 'FAIL same key: no event id in the first answer' >&2; exit 1; }
expect 'same key: the first appends' appended "$(status_of rk_holder)"
expect 'same key: the second replays it' replayed "$(status_of rk_waiter)"
expect 'same key: the replayed event is the first one' "$first" "$(grep -oE '"id": ?"[0-9a-f-]{36}"' "$work/rk_waiter" | head -1)"
expect 'same key: one row' 1 "$(rows_of "$g")"

expect 'no write ticket is left behind' 0 "$(q "select count(*) from private.v5_write_tickets")"
echo 'ALL PASS'
