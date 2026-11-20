#!/usr/bin/env bash
# Disposable local-only two-session suite for create_entry_contract (row 2,
# stage A) and its agreement-snapshot parity. Requires trustflow-localdb.
set -euo pipefail
cd "$(dirname "$0")/../.."
container=trustflow-localdb
db="trustflow_c5race_$$"
logdir="$(mktemp -d "${TMPDIR:-/tmp}/trustflowc5.XXXXXX")"
cleanup() {
  docker exec "$container" dropdb -U postgres --if-exists --force "$db" >/dev/null 2>&1 || echo "Could not drop disposable database $db" >&2
  rm -rf "$logdir"
}
trap cleanup EXIT
psql_local() { docker exec -i "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1; }
docker exec "$container" createdb -U postgres "$db"
docker exec "$container" pg_dump -U postgres -d postgres --schema-only --no-owner --no-privileges | psql_local >"$logdir/schema"
psql_local < supabase/migrations/20261118214020_entry_agent_credentials.sql
psql_local < supabase/migrations/20261120090000_create_entry_contract.sql
owner=11111111-1111-4111-8111-111111111111
draft=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
gone=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
psql_local <<SQL
insert into auth.users(id,email,is_anonymous,email_confirmed_at) values ('$owner','owner-c5race@example.test',false,clock_timestamp());
insert into public.contracts(id,earner_user_id,project_name,dod,amount_minor,invited_hirer_email) values
  ('$draft','$owner','issue target','["x"]',1,'g@example.test'),
  ('$gone','$owner','delete target','["x"]',1,'g@example.test');
SQL
create_sql="select set_config('request.jwt.claim.sub','$owner',true); select (r->>'status') || ':' || coalesce(r->'contract'->>'earner_user_id','-') from public.create_entry_contract('race','[\"a\"]',1,'JPY',null,'g@example.test','creator',null) r"
hold() {
  local statement="$1" i
  docker exec -e PGAPPNAME=c5_hold "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1 -c "begin; $statement; select pg_sleep(4); commit" >"$logdir/holder" 2>&1 &
  holder=$!
  for i in {1..100}; do
    if [[ "$(psql_local <<< "select count(*) from pg_stat_activity where application_name='c5_hold' and wait_event='PgSleep'")" == 1 ]]; then return; fi
    kill -0 "$holder" 2>/dev/null || { cat "$logdir/holder" >&2; return 1; }
    sleep .05
  done
  echo 'lock holder did not enter sleep' >&2; return 1
}
expect() { [[ "$2" == "$1" ]] || { printf 'FAIL %s: expected %s, got %s\n' "$3" "$1" "$2" >&2; exit 1; }; echo "PASS $3"; }
# Run in the second session, single transaction; a 2 s lock_timeout turns an unexpected wait into a failure.
second() { psql_local <<< "begin; set local lock_timeout = '2s'; $1; commit;" | tail -1; }
waits() { psql_local <<< "begin; $1; commit;" | tail -1; }
reset_owner() { psql_local <<< "update auth.users set email='owner-c5race@example.test', email_confirmed_at=clock_timestamp() where id='$owner'"; }

# 1. Account change commits while create waits on the user-row lock: create sees it.
hold "update auth.users set email_confirmed_at=null where id='$owner'"
actual=$(waits "$create_sql"); wait "$holder"
expect "not_authorized:-" "$actual" "unconfirm during create wait -> refused"
reset_owner
hold "update auth.users set email='changed-c5race@example.test' where id='$owner'"
actual=$(waits "$create_sql"); wait "$holder"
expect "created:$owner" "$actual" "email change during create wait -> created, owner unchanged"
reset_owner
# 2. Create holds the user row; an account change waits and then commits.
hold "$create_sql"
actual=$(waits "update auth.users set email_confirmed_at=null where id='$owner' returning 'updated'"); wait "$holder"
expect "updated" "$actual" "unconfirm after create holds lock -> waits, then commits"
expect "created:$owner" "$(grep -E '^(created|not_authorized)' "$logdir/holder")" "create holding lock committed with right owner"
reset_owner
# 3. Create vs credential issue on another deal of the same owner: both share the user row, neither blocks.
issue_sql="select public.issue_entry_agent_credential(gen_random_uuid(),'$draft','$owner','owner_account',encode(sha256(gen_random_uuid()::text::bytea),'hex'),array['read'],clock_timestamp()+interval '1 day',null)->>'status'"
hold "$issue_sql"
actual=$(second "$create_sql"); wait "$holder"
expect "created:$owner" "$actual" "create while issue holds contract+user locks -> no wait"
expect "issued" "$(grep -E '^(issued|invalid_grant|not_authorized)' "$logdir/holder")" "issue holding locks committed"
hold "$create_sql"
actual=$(second "$issue_sql"); wait "$holder"
expect "issued" "$actual" "issue while create holds user lock -> no wait"
# 4. Create vs draft delete of another deal: no shared lock, neither blocks.
hold "delete from public.contracts where id='$gone'"
actual=$(second "$create_sql"); wait "$holder"
expect "created:$owner" "$actual" "create while delete holds contract lock -> no wait"
hold "$create_sql"
gone2=$(psql_local <<< "insert into public.contracts(earner_user_id,project_name,dod,amount_minor,invited_hirer_email) values ('$owner','d2','[\"x\"]',1,'g@example.test') returning id")
actual=$(second "delete from public.contracts where id='$gone2' returning 'deleted'"); wait "$holder"
expect "deleted" "$actual" "delete while create holds user lock -> no wait"
# 5. Snapshot parity rows: same terms via the RPC and via the legacy direct insert.
psql_local <<SQL > "$logdir/rows.json"
select set_config('request.jwt.claim.sub','$owner',false) \\g /dev/null
with legacy as (
  insert into public.contracts(earner_user_id,project_name,dod,amount_minor,currency,deadline,invited_hirer_email,performed_by,earner_display_name)
  values ('$owner','Parity','["a","b c"]',123456,'JPY','2099-12-31','G@Example.test','counterparty','Owner Ü') returning *)
select json_build_object(
  'rpc', public.create_entry_contract('Parity','["a","b c"]',123456,'JPY','2099-12-31','G@Example.test','counterparty','Owner Ü')->'contract',
  'legacy', (select to_jsonb(l) from legacy l));
SQL
node --experimental-strip-types --no-warnings tests/sql/snapshot_parity.mts "$logdir/rows.json"
