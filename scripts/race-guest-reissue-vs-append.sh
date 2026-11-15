#!/usr/bin/env bash
# Guest append vs. reissue, both orders, on a LOCAL disposable database.
#
#   LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
#     npm run test:race:guest
#
# WHAT IT PROVES, AND HOW
# 20261114120000 claims: after reissue_guest_access commits, the old guest
# token cannot create an event; a guest append that took the contract lock
# first commits first; a replay is authorised before it is answered; expiry is
# decided by the database clock under the lock. Each claim is a case below.
#
# Unlike scripts/race-delete-vs-append.mjs this does not sweep delays and hope
# the two orders occur. One session takes the lock and holds it with
# pg_sleep; the other starts while it is held, so the order is forced, and the
# waiting side's clock reading after it returns is compared with the holder's
# reading just before its commit to show it really waited.
#
# WHERE IT MAY RUN
# Only against a loopback database that has every migration applied (e.g. a
# `supabase start` stack). It writes permanent, undeletable events — `events`
# is append-only — so it refuses any URL that is not 127.0.0.1/localhost/::1,
# and any URL naming either Supabase project. It never touches E2E or
# production, and it is not part of any suite.
set -euo pipefail

URL="${LOCAL_DB_URL:-}"
die() { echo "FAIL: $*" >&2; exit 1; }
[ -n "$URL" ] || die "set LOCAL_DB_URL to a local disposable database"
case "$URL" in
  *supabase.co*|*supabase.com*|*fqgpzhwvvfsxswlnbbgg*|*yqjtawffpesplqyurlpj*)
    die "refusing a hosted Supabase URL" ;;
esac
case "$URL" in
  *@127.0.0.1:*|*@127.0.0.1/*|*@localhost:*|*@localhost/*|*@\[::1\]:*) ;;
  *) die "refusing a non-loopback database URL" ;;
esac
command -v psql >/dev/null || die "psql is required"

q() { psql "$URL" -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }
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

# append_sql <token> <idempotency key or null> [type]
append_sql() {
  local key="null"; [ "$2" != "null" ] && key="'$2'"
  echo "with t as (select $TIP as h)
        select public.append_guest_event('$CID', '$1', t.h, jsonb_build_object(
          'type', '${3:-rating.submitted}', 'contract_id', '$CID', 'actor_id', '$ACTOR',
          'payload', '{}'::jsonb, 'created_at', clock_timestamp(),
          'event_hash', md5(random()::text), 'prev_event_hash', t.h,
          'idempotency_key', $key::text))->>'status' from t;"
}
# reissue_sql <new token>
reissue_sql() {
  echo "with t as (select $TIP as h)
        select public.reissue_guest_access('$CID', null, '$1', now() + interval '1 day', t.h,
          jsonb_build_object('type', 'access.reissued', 'contract_id', '$CID',
            'actor_id', 'race-owner', 'payload', '{}'::jsonb, 'created_at', clock_timestamp(),
            'event_hash', md5(random()::text), 'prev_event_hash', t.h))->>'status' from t;"
}
events() { q -c "select count(*) from public.events where contract_id = '$CID';"; }
epoch="extract(epoch from clock_timestamp())"

echo "privileges"
for role in anon authenticated; do
  check "$role cannot execute" "$(q -c "select has_function_privilege('$role',
    'public.append_guest_event(uuid,text,text,jsonb)', 'execute');")" "f"
done

echo "reissue-then-append: the old token is refused once the reissue commits"
T2="$(new_token)"
q -c "begin;" -c "$(reissue_sql "$T2")" -c "select pg_sleep(2);" \
  -c "select $epoch;" -c "commit;" > "$TMP/a.holder" &
HOLDER=$!
sleep 0.5
WAITER="$(q -c "$(append_sql "$T1" null)" -c "select $epoch;")"
wait "$HOLDER"
check "reissue" "$(sed -n 1p "$TMP/a.holder")" "reissued"
check "old-token append" "$(echo "$WAITER" | sed -n 1p)" "guest_credential_revoked"
check "append waited for the reissue commit" "$(awk -v w="$(echo "$WAITER" | sed -n '$p')" \
  -v h="$(sed -n '$p' "$TMP/a.holder")" 'BEGIN { print (w > h) ? "yes" : "no" }')" "yes"
check "new-token append" "$(q -c "$(append_sql "$T2" null)")" "appended"

echo "append-then-reissue: the append holding the lock lands first"
BEFORE="$(events)"
q -c "begin;" -c "$(append_sql "$T2" race-b1)" -c "select pg_sleep(2);" \
  -c "select $epoch;" -c "commit;" > "$TMP/b.holder" &
HOLDER=$!
sleep 0.5
T3="$(new_token)"
WAITER="$(q -c "$(reissue_sql "$T3")" -c "select $epoch;")"
wait "$HOLDER"
check "append" "$(sed -n 1p "$TMP/b.holder")" "appended"
# The reissue read its tip before the append committed, so it must refuse
# rather than link past the new event; its Edge Function retries.
check "waiting reissue" "$(echo "$WAITER" | sed -n 1p)" "chain_conflict"
check "reissue waited for the append commit" "$(awk -v w="$(echo "$WAITER" | sed -n '$p')" \
  -v h="$(sed -n '$p' "$TMP/b.holder")" 'BEGIN { print (w > h) ? "yes" : "no" }')" "yes"
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
check "same operation again" "$(q -c "$(append_sql "$T3" race-r1)")" "replayed"
check "replay wrote nothing" "$(events)" "$BEFORE"
check "same key, other type" "$(q -c "$(append_sql "$T3" race-r1 dispute.opened)")" \
  "idempotency_key_in_use"
T4="$(new_token)"
check "reissue" "$(q -c "$(reissue_sql "$T4")")" "reissued"
check "replay with the replaced token" "$(q -c "$(append_sql "$T3" race-r1)")" \
  "guest_credential_revoked"

echo "expiry is the database clock, under the lock"
q -c "update public.contracts set guest_access_token_expires_at = clock_timestamp() - interval '1 second'
       where id = '$CID';" >/dev/null
BEFORE="$(events)"
check "expired append" "$(q -c "$(append_sql "$T4" null)")" "guest_credential_expired"
check "expired replay" "$(q -c "$(append_sql "$T4" race-r1)")" "guest_credential_expired"
check "nothing written" "$(events)" "$BEFORE"

echo "failures roll back"
q -c "update public.contracts set guest_access_token_expires_at = now() + interval '1 day'
       where id = '$CID';" >/dev/null
BEFORE="$(events)"
# A stamp behind the chain is refused by the insert trigger inside the
# function's transaction (TF003); nothing of the call survives.
BACKWARDS="$(append_sql "$T4" race-f1 | sed "s/'created_at', clock_timestamp()/'created_at', timestamptz '2000-01-01'/")"
if q -c "$BACKWARDS" > /dev/null 2> "$TMP/f.err"; then FAULT="none"
else FAULT="$(grep -q 'TF003\|behind' "$TMP/f.err" && echo TF003 || cat "$TMP/f.err")"; fi
check "backwards stamp refused" "$FAULT" "TF003"
check "nothing written" "$(events)" "$BEFORE"
if q -c "begin isolation level repeatable read;" -c "$(append_sql "$T4" race-f2)" \
     -c "commit;" > /dev/null 2> "$TMP/i.err"; then ISO="accepted"
else ISO="$(grep -q 'READ COMMITTED' "$TMP/i.err" && echo TF005 || cat "$TMP/i.err")"; fi
check "repeatable read refused" "$ISO" "TF005"
check "nothing written" "$(events)" "$BEFORE"

if [ "$FAILS" -ne 0 ]; then echo; die "$FAILS check(s) failed"; fi
echo; echo "PASS"
