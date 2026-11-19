#!/usr/bin/env bash
# Disposable local-only two-session regression suite. Requires the isolated
# trustflow-localdb container used by the SQL fixture; never targets a URL.
set -euo pipefail
cd "$(dirname "$0")/../.."
container=trustflow-localdb
db="trustflow_task128_$$"
logdir="$(mktemp -d "${TMPDIR:-/tmp}/trustflow128.XXXXXX")"
cleanup() {
  docker exec "$container" dropdb -U postgres --if-exists --force "$db" >/dev/null 2>&1 || echo "Could not drop disposable database $db" >&2
  rm -rf "$logdir"
}
trap cleanup EXIT
psql_local() { docker exec -i "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1; }
docker exec "$container" createdb -U postgres "$db"
docker exec "$container" pg_dump -U postgres -d postgres --schema-only --no-owner --no-privileges | psql_local >"$logdir/schema"
psql_local < supabase/migrations/20261118214020_entry_agent_credentials.sql
psql_local <<'SQL'
insert into auth.users(id,email,is_anonymous,email_confirmed_at) values
('11111111-1111-4111-8111-111111111111','owner-race@example.test',false,clock_timestamp()),
('22222222-2222-4222-8222-222222222222','guest-race@example.test',false,clock_timestamp());
insert into public.contracts(id,earner_user_id,project_name,dod,amount_jpy,invited_hirer_email,invite_token,invite_token_expires_at) values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','race','["test"]',1,'guest-race@example.test','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',clock_timestamp()+interval '1 day');
SQL
hold() {
  local statement="$1" i
  docker exec -e PGAPPNAME=task128_hold "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1 -c "begin; $statement; select pg_sleep(4); commit" >"$logdir/holder" 2>&1 &
  holder=$!
  for i in {1..100}; do
    if [[ "$(psql_local <<< "select count(*) from pg_stat_activity where application_name='task128_hold' and wait_event='PgSleep'")" == 1 ]]; then return; fi
    kill -0 "$holder" 2>/dev/null || { cat "$logdir/holder" >&2; return 1; }
    sleep .05
  done
  echo 'lock holder did not enter sleep' >&2; return 1
}
expect() { local expected="$1" actual="$2"; [[ "$actual" == "$expected" ]] || { printf 'expected %s, got %s\n' "$expected" "$actual" >&2; return 1; }; }
owner=11111111-1111-4111-8111-111111111111
guest=22222222-2222-4222-8222-222222222222
contract=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
# The expiry is computed by the waiting statement before the blocked RPC executes.
hold "select id from public.contracts where id='$contract' for update"
actual=$(psql_local <<< "select public.issue_entry_agent_credential('cccccccc-cccc-4ccc-8ccc-cccccccccccc','$contract','$owner','owner_account',repeat('a',64),array['read'],clock_timestamp()+interval '1 second',null)->>'status'")
wait "$holder"; expect invalid_grant "$actual"
echo 'PASS expiry during contract lock'
# A committed account change while issuance waits must be observed after the lock.
hold "update auth.users set email='changed-race@example.test' where id='$guest'"
actual=$(psql_local <<< "select public.issue_entry_agent_credential('cccccccc-cccc-4ccc-8ccc-cccccccccccc','$contract','$guest','counterpart_account',repeat('a',64),array['accept'],clock_timestamp()+interval '1 day','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')->>'status'")
wait "$holder"; expect not_authorized "$actual"
echo 'PASS account change during user lock'
# Revocation waits on the same contract lock as an in-flight issue.
hold "select public.issue_entry_agent_credential('cccccccc-cccc-4ccc-8ccc-cccccccccccc','$contract','$owner','owner_account',repeat('a',64),array['read'],clock_timestamp()+interval '1 day',null)"
actual=$(psql_local <<< "select public.revoke_entry_agent_credential('$contract','cccccccc-cccc-4ccc-8ccc-cccccccccccc','$owner')->>'status'")
wait "$holder"; expect revoked "$actual"
actual=$(psql_local <<< "select (revoked_at is not null)::text from public.entry_agent_credentials where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'")
expect true "$actual"
echo 'PASS issue then concurrent revoke'
# Expiry while waiting for user-row lock.
hold "select id from auth.users where id='$owner' for update"
actual=$(psql_local <<< "select public.issue_entry_agent_credential('dddddddd-dddd-4ddd-8ddd-dddddddddddd','$contract','$owner','owner_account',repeat('b',64),array['read'],clock_timestamp()+interval '1 second',null)->>'status'")
wait "$holder"; expect invalid_grant "$actual"
echo 'PASS expiry during user lock'
# Delete-first prevents issuance after the delete transaction commits.
psql_local <<< "insert into public.contracts(id,earner_user_id,project_name,dod,amount_jpy) values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','$owner','delete first','[\"test\"]',1)"
hold "delete from public.contracts where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'"
actual=$(psql_local <<< "select public.issue_entry_agent_credential('dddddddd-1111-4111-8111-111111111111','dddddddd-dddd-4ddd-8ddd-dddddddddddd','$owner','owner_account',repeat('b',64),array['read'],clock_timestamp()+interval '1 day',null)->>'status'")
wait "$holder"; expect not_authorized "$actual"
echo 'PASS delete then concurrent issue'
# Issue-first makes the waiting delete fail with the distinct SQLSTATE.
psql_local <<< "insert into public.contracts(id,earner_user_id,project_name,dod,amount_jpy) values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','$owner','issue first','[\"test\"]',1)"
hold "select public.issue_entry_agent_credential('eeeeeeee-1111-4111-8111-111111111111','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','$owner','owner_account',repeat('c',64),array['read'],clock_timestamp()+interval '1 day',null)"
actual=$(psql_local <<'SQL'
do $$ begin
  begin
    delete from public.contracts where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    raise exception 'delete did not fail';
  exception when sqlstate 'TF007' then raise notice 'PASS expected TF007'; end;
end $$;
SQL
)
wait "$holder"
echo 'PASS issue then concurrent delete'
