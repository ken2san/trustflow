#!/usr/bin/env bash
# Guest append vs. reissue, both orders, on a LOCAL disposable database.
#
#   npm run test:race:guest -- --self-check     guard checks, no DB
#   LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
#     npm run test:race:guest
#
# WHAT IT PROVES, AND HOW
# 20261114120000 claims: after reissue_guest_access commits, the old guest
# token cannot create an event; a guest append that took the contract lock
# first commits first; a replay is authorised before it is answered; expiry is
# decided by the database clock under the lock. Each claim is a case below.
# The migration's own self-test covers the single-session rules; this covers
# the two-session ones it cannot.
#
# THE ORDER IS FORCED AND THEN PROVEN, not inferred from timing. The holder
# session takes the contract lock and keeps its transaction open. The waiter
# starts only once the holder's write is visible as in progress, and the
# holder does not commit until it has itself observed — through
# pg_blocking_pids — that the waiter is blocked on a lock the holder holds.
# Only then does it print `waiter-blocked` and commit. A run where the waiter
# never blocked times out inside the holder, rolls the holder back, and fails.
# (Codex Task 76: comparing completion clocks did not show the waiter had
# started before the holder released.)
#
# WHERE IT MAY RUN
# Only a loopback database with every migration applied and the opt-in marker
# set — see scripts/lib/local-db-guard.sh for the guard and why it is strict.
# It writes permanent, undeletable events. It never touches E2E or production
# and is not part of any suite.
set -euo pipefail

source "$(dirname "$0")/lib/local-db-guard.sh"
die() { echo "FAIL: $*" >&2; exit 1; }

if [ "${1:-}" = "--self-check" ]; then
  guard_self_check "$0" && { echo "guard self-check PASS"; exit 0; }
  die "guard self-check"
fi

why="$(refuse_redirecting_env)" || die "$why"
# In this shell, not $(...): the parsed parts must survive the call.
parse_local_db_url "${LOCAL_DB_URL:-}" || die "LOCAL_DB_URL: $GUARD_WHY"
why="$(local_conninfo race-guest)" || die "LOCAL_DB_URL: $why"
command -v psql >/dev/null || die "psql is required"

# qa APP_NAME psql-args… — the connection is rebuilt from the validated parts,
# never from the URL; local_conninfo re-checks and quotes each one.
qa() {
  local app="$1" conninfo; shift
  conninfo="$(local_conninfo "$app")" || die "conninfo: $conninfo"
  PGPASSWORD="$DB_PASS" psql "$conninfo" -X -q -t -A -v ON_ERROR_STOP=1 "$@"
}
q() { qa race-guest "$@"; }

# Before any write: is this really the disposable database?
IFS='|' read -r ADDR MARKER FINGERPRINT <<< "$(q -c "
  select coalesce(host(inet_server_addr()), 'socket')
      || '|' || coalesce(current_setting('trustflow.disposable_race_db', true), '')
      || '|' || current_database() || ' ' || coalesce(current_setting('cluster_name', true), '')
      || ' ' || (select coalesce(string_agg(datname, ' '), '') from pg_catalog.pg_database);")"
why="$(judge_server "$ADDR" "$MARKER" "$FINGERPRINT")" || die "refusing this server: $why"
echo "server $ADDR, marker present"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
GUEST='race-guest@example.invalid'
ACTOR="guest:$GUEST"
FAILS=0
check() { # check <label> <got> <want>
  if [ "$2" = "$3" ]; then echo "  ok   $1"
  else echo "  FAIL $1: got '$2', want '$3'"; FAILS=$((FAILS + 1)); fi
}

# A contract in the accepted-credential shape: hirer recorded, invite used,
# a live guest token. Inserted as the superuser, the way the migrations'
# own self-tests seed one.
CID="$(q -c "
  insert into public.contracts (project_name, dod, amount_minor, currency)
  values ('race guest reissue vs append $(date -u +%FT%TZ)', '[\"race\"]'::jsonb, 1, 'JPY')
  returning id;")"
new_token() { q -c "select gen_random_uuid();"; }
T1="$(new_token)"
q -c "update public.contracts
         set hirer_email = '$GUEST', invite_token_used_at = now(),
             guest_access_token = '$T1',
             guest_access_token_expires_at = now() + interval '1 day'
       where id = '$CID';" >/dev/null
echo "contract $CID"

TIP="coalesce((select event_hash from public.events
                where contract_id = '$CID' and event_hash is not null
                order by created_at desc, id desc limit 1), 'GENESIS')"

# Every synthetic event carries its own id: both RPCs insert through
# jsonb_populate_record + SELECT *, which writes NULL for an absent key rather
# than taking the column default, and events.id is NOT NULL. buildEventRecord
# always supplies one; this fixture has to as well.

# append_sql <token> <idempotency key or null> [type]
append_sql() {
  local key="null"; [ "$2" != "null" ] && key="'$2'"
  echo "with t as (select $TIP as h)
        select public.append_guest_event('$CID', '$1', t.h, jsonb_build_object(
          'id', gen_random_uuid(),
          'type', '${3:-rating.submitted}', 'contract_id', '$CID', 'actor_id', '$ACTOR',
          'payload', '{}'::jsonb, 'created_at', clock_timestamp(),
          'event_hash', md5(random()::text), 'prev_event_hash', t.h,
          'idempotency_key', $key::text))->>'status' from t;"
}
# replay_sql <token> <key> [type]
replay_sql() {
  echo "select public.replay_guest_event('$CID', '$1', '${3:-rating.submitted}', '$ACTOR', '$2')->>'status';"
}
# reissue_sql <new token>
reissue_sql() {
  echo "with t as (select $TIP as h)
        select public.reissue_guest_access('$CID', null, '$1', now() + interval '1 day', t.h,
          jsonb_build_object('id', gen_random_uuid(),
            'type', 'access.reissued', 'contract_id', '$CID',
            'actor_id', 'race-owner', 'payload', '{}'::jsonb, 'created_at', clock_timestamp(),
            'event_hash', md5(random()::text), 'prev_event_hash', t.h))->>'status' from t;"
}
events() { q -c "select count(*) from public.events where contract_id = '$CID';"; }

# The holder's half of the handshake: wait, inside the open transaction, until
# a session named $1 is blocked by this one. pg_stat_activity is snapshotted
# per transaction, so the snapshot is cleared on every pass; pg_blocking_pids
# reads the lock manager live.
handshake_sql() {
  echo "do \$\$
        declare i int := 0;
        begin
          loop
            perform pg_stat_clear_snapshot();
            exit when exists (
              select 1 from pg_stat_activity a
               where a.application_name = '$1'
                 and pg_backend_pid() = any(pg_blocking_pids(a.pid)));
            i := i + 1;
            if i > 200 then
              raise exception 'handshake timeout: % never blocked on this session', '$1';
            end if;
            perform pg_sleep(0.05);
          end loop;
        end \$\$;"
}

# race <tag> <holder SQL> <waiter SQL> — runs the holder in the background,
# starts the waiter once the holder's write is in progress, and leaves the
# outputs in $TMP/<tag>.holder and $TMP/<tag>.waiter.
race() {
  local tag="$1" holder_sql="$2" waiter_sql="$3" i=0
  qa "race-holder-$tag" -c "begin;" -c "$holder_sql" -c "$(handshake_sql "race-waiter-$tag")" \
    -c "select 'waiter-blocked';" -c "commit;" > "$TMP/$tag.holder" 2> "$TMP/$tag.holder.err" &
  local holder=$!
  # The holder has written (and so holds the contract lock) once its backend
  # has a transaction id.
  until [ "$(q -c "select count(*) from pg_stat_activity
                    where application_name = 'race-holder-$tag' and backend_xid is not null;")" = 1 ]; do
    i=$((i + 1)); [ "$i" -gt 100 ] && die "$tag: holder never took the lock"
    sleep 0.1
  done
  qa "race-waiter-$tag" -c "$waiter_sql" > "$TMP/$tag.waiter" 2> "$TMP/$tag.waiter.err" || true
  wait "$holder" || true
}

echo "reissue-then-append: the old token is refused once the reissue commits"
T2="$(new_token)"
race a "$(reissue_sql "$T2")" "$(append_sql "$T1" null)"
check "reissue" "$(sed -n 1p "$TMP/a.holder")" "reissued"
check "waiter was blocked by the reissue before it committed" "$(sed -n '$p' "$TMP/a.holder")" "waiter-blocked"
check "old-token append" "$(sed -n 1p "$TMP/a.waiter")" "guest_credential_revoked"
check "new-token append" "$(q -c "$(append_sql "$T2" null)")" "appended"

echo "append-then-reissue: the append holding the lock lands first"
BEFORE="$(events)"
T3="$(new_token)"
race b "$(append_sql "$T2" race-b1)" "$(reissue_sql "$T3")"
check "append" "$(sed -n 1p "$TMP/b.holder")" "appended"
check "waiter was blocked by the append before it committed" "$(sed -n '$p' "$TMP/b.holder")" "waiter-blocked"
# The reissue read its tip before the append committed, so it must refuse
# rather than link past the new event; its Edge Function retries.
check "waiting reissue" "$(sed -n 1p "$TMP/b.waiter")" "chain_conflict"
check "retried reissue" "$(q -c "$(reissue_sql "$T3")")" "reissued"
check "the append is ordered before access.reissued" "$(q -c "
  select string_agg(type, ',' order by created_at, id) from public.events
   where contract_id = '$CID' and (idempotency_key = 'race-b1' or type = 'access.reissued')
     and created_at >= (select created_at from public.events
                         where contract_id = '$CID' and idempotency_key = 'race-b1');")" \
  "rating.submitted,access.reissued"
check "one event from the append, one from the reissue" "$(events)" "$((BEFORE + 2))"
check "old-token append after it" "$(q -c "$(append_sql "$T2" null)")" "guest_credential_revoked"

echo "replay is authorised before it is answered"
check "first write" "$(q -c "$(append_sql "$T3" race-r1)")" "appended"
BEFORE="$(events)"
check "replay_guest_event" "$(q -c "$(replay_sql "$T3" race-r1)")" "replayed"
check "same operation through append" "$(q -c "$(append_sql "$T3" race-r1)")" "replayed"
check "replay wrote nothing" "$(events)" "$BEFORE"
check "same key, other type" "$(q -c "$(replay_sql "$T3" race-r1 dispute.opened)")" \
  "idempotency_key_in_use"
T4="$(new_token)"
check "reissue" "$(q -c "$(reissue_sql "$T4")")" "reissued"
check "replay with the replaced token" "$(q -c "$(replay_sql "$T3" race-r1)")" \
  "guest_credential_revoked"

echo "a replay waits for a reissue holding the lock, then is refused"
T5="$(new_token)"
race c "$(reissue_sql "$T5")" "$(replay_sql "$T4" race-r1)"
check "reissue" "$(sed -n 1p "$TMP/c.holder")" "reissued"
check "waiter was blocked by the reissue before it committed" "$(sed -n '$p' "$TMP/c.holder")" "waiter-blocked"
check "replay with the token just replaced" "$(sed -n 1p "$TMP/c.waiter")" "guest_credential_revoked"

echo "expiry is the database clock, under the lock"
q -c "update public.contracts set guest_access_token_expires_at = clock_timestamp() - interval '1 second'
       where id = '$CID';" >/dev/null
BEFORE="$(events)"
check "expired append" "$(q -c "$(append_sql "$T5" null)")" "guest_credential_expired"
check "expired replay" "$(q -c "$(replay_sql "$T5" race-r1)")" "guest_credential_expired"
check "nothing written" "$(events)" "$BEFORE"

echo "failures roll back"
q -c "update public.contracts set guest_access_token_expires_at = now() + interval '1 day'
       where id = '$CID';" >/dev/null
BEFORE="$(events)"
# A stamp behind the chain is refused by the insert trigger inside the
# function's transaction (TF003); nothing of the call survives.
BACKWARDS="$(append_sql "$T5" race-f1 | sed "s/'created_at', clock_timestamp()/'created_at', timestamptz '2000-01-01'/")"
if q -c "$BACKWARDS" > /dev/null 2> "$TMP/f.err"; then FAULT="none"
else FAULT="$(grep -q 'TF003\|behind' "$TMP/f.err" && echo TF003 || cat "$TMP/f.err")"; fi
check "backwards stamp refused" "$FAULT" "TF003"
check "nothing written" "$(events)" "$BEFORE"
if q -c "begin isolation level repeatable read;" -c "$(append_sql "$T5" race-f2)" \
     -c "commit;" > /dev/null 2> "$TMP/i.err"; then ISO="accepted"
else ISO="$(grep -q 'READ COMMITTED' "$TMP/i.err" && echo TF005 || cat "$TMP/i.err")"; fi
check "repeatable read refused" "$ISO" "TF005"
check "nothing written" "$(events)" "$BEFORE"

if [ "$FAILS" -ne 0 ]; then echo; die "$FAILS check(s) failed"; fi
echo; echo "PASS"
