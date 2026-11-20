#!/usr/bin/env bash
# Disposable local-only runner for tests/sql/create_entry_contract.sql. Requires
# the trustflow-localdb container; never targets a URL.
#
# Fixture: the local schema with owners and ACLs kept, restored as the platform
# superuser (supabase_admin), because postgres may not recreate objects owned by
# platform roles. Fails closed: any dump or restore error stops the run. The only
# entries left out are the database's event triggers (platform DDL hooks: the
# PostgREST schema watch, pg_graphql/pg_cron/pg_net grants, ensure_rls), which a
# restore cannot recreate under supautils and which no test here depends on.
# The migrations and tests then run as postgres, as on a hosted project.
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${TF_FIXTURE_CONTAINER:-trustflow-localdb}"
db="trustflow_c5_$$"
dump="/tmp/${db}.dump"
work="$(mktemp -d "${TMPDIR:-/tmp}/trustflowc5fixture.XXXXXX")"
cleanup() {
  docker exec "$container" dropdb -U supabase_admin --if-exists --force "$db" >/dev/null 2>&1 || echo "Could not drop disposable database $db" >&2
  docker exec "$container" rm -f "$dump" "$dump.list" || echo "Could not remove $dump in the container" >&2
  rm -rf "$work"
}
trap cleanup EXIT
psql_local() { docker exec -i "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1; }
# Owned by postgres, as the source database is: public CREATE comes via pg_database_owner.
docker exec "$container" createdb -U supabase_admin -O postgres "$db"
docker exec "$container" pg_dump -U supabase_admin -d postgres --schema-only -Fc -f "$dump"
# The TOC is written whole by one checked command, then filtered by others; no
# pipeline can hide a failing pg_restore -l. TF_FIXTURE_FAULT=toc replaces the
# TOC step with one that prints partial output and fails, and =event_trigger adds
# an unreviewed event trigger, to prove the runner stops before restore (tests/sql/create_entry_contract_harness_check.sh).
toc() {
  if [[ "${TF_FIXTURE_FAULT:-}" == toc ]]; then
    echo 'FAULT-INJECTED: toc' >&2; echo '1; 0 0 SCHEMA - public postgres'; return 1
  fi
  docker exec "$container" pg_restore -l "$dump"
  if [[ "${TF_FIXTURE_FAULT:-}" == event_trigger ]]; then
    echo 'FAULT-INJECTED: event_trigger' >&2; echo '9999; 3466 1 EVENT TRIGGER - unreviewed_hook postgres'
  fi
}
toc > "$work/toc.full"
grep -c ' SCHEMA \| TABLE ' "$work/toc.full" >/dev/null || { echo 'fixture: TOC has no schemas or tables' >&2; exit 1; }
# Only the event triggers reviewed in Task 156 may be excluded, and all of them
# must be there: a new or missing platform hook stops the run for review.
reviewed='ensure_rls
issue_graphql_placeholder
issue_pg_cron_access
issue_pg_graphql_access
issue_pg_net_access
pgrst_ddl_watch
pgrst_drop_watch'
awk '$4 == "EVENT" && $5 == "TRIGGER" { print $7 }' "$work/toc.full" | sort > "$work/excluded"
if [[ "$(cat "$work/excluded")" != "$reviewed" ]]; then
  echo 'fixture: event triggers differ from the reviewed set:' >&2
  diff <(printf '%s\n' "$reviewed") "$work/excluded" >&2 || true
  exit 1
fi
awk '!($4 == "EVENT" && $5 == "TRIGGER")' "$work/toc.full" > "$work/toc.list"
[[ $(( $(wc -l < "$work/toc.full") - $(wc -l < "$work/toc.list") )) -eq 7 ]] || { echo 'fixture: TOC filter removed other than 7 entries' >&2; exit 1; }
docker cp "$work/toc.list" "$container:$dump.list"
echo 'fixture: restoring'
docker exec "$container" pg_restore -U supabase_admin -d "$db" --exit-on-error -L "$dump.list" "$dump"

# The fixture must carry what the tests depend on, or it is not a fixture.
psql_local <<'SQL'
do $$
declare
  missing text;
  client_insert text[] := array['amount_jpy','amount_minor','currency','deadline','dod','earner_display_name',
    'earner_user_id','invited_hirer_email','performed_by','project_name'];
begin
  select string_agg(x, ', ') into missing from unnest(array['parties_read_own_contracts','creator_insert_contract',
    'verified_earner_only_insert','owner_delete_unaccepted_draft']) x
  where not exists (select 1 from pg_policy where polrelid = 'public.contracts'::regclass and polname = x);
  if missing is not null then raise exception 'fixture: missing contracts policies: %', missing; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.contracts'::regclass) then
    raise exception 'fixture: RLS off on contracts'; end if;
  select string_agg(x, ', ') into missing from unnest(array['contracts_fill_amount_minor','contracts_freeze_accepted_terms',
    'contracts_refuse_delete_with_evidence','contracts_updated_at','validate_contract_creation_only']) x
  where not exists (select 1 from pg_trigger where tgrelid = 'public.contracts'::regclass and tgname = x and tgenabled <> 'D');
  if missing is not null then raise exception 'fixture: missing or disabled contracts triggers: %', missing; end if;
  select string_agg(x, ', ') into missing from unnest(array['public.require_read_committed(text)','auth.uid()']) x
  where to_regprocedure(x) is null;
  if missing is not null then raise exception 'fixture: missing functions: %', missing; end if;
  if not has_schema_privilege('postgres', 'public', 'CREATE')
     or pg_get_userbyid((select datdba from pg_database where datname = current_database())) is distinct from 'postgres' then
    raise exception 'fixture: database or public schema not owned/creatable by postgres'; end if;
  if pg_get_userbyid((select relowner from pg_class where oid = 'public.contracts'::regclass)) is distinct from 'postgres' then
    raise exception 'fixture: contracts is not owned by postgres'; end if;
  -- Effective grants: every column readable by authenticated, the client INSERT
  -- column set exactly as today, no client UPDATE, authenticated DELETE only.
  select string_agg(attname, ', ') into missing from pg_attribute
  where attrelid = 'public.contracts'::regclass and attnum > 0 and not attisdropped
    and not has_column_privilege('authenticated', 'public.contracts', attname, 'SELECT');
  if missing is not null then raise exception 'fixture: authenticated cannot select %', missing; end if;
  if (select array_agg(attname::text order by attname) from pg_attribute
      where attrelid = 'public.contracts'::regclass and attnum > 0 and not attisdropped
        and has_column_privilege('authenticated', 'public.contracts', attname, 'INSERT')) is distinct from client_insert then
    raise exception 'fixture: authenticated INSERT columns differ from the expected set'; end if;
  if has_any_column_privilege('anon', 'public.contracts', 'INSERT') or has_any_column_privilege('authenticated', 'public.contracts', 'UPDATE')
     or has_any_column_privilege('anon', 'public.contracts', 'UPDATE') or not has_table_privilege('authenticated', 'public.contracts', 'DELETE')
     or has_table_privilege('anon', 'public.contracts', 'DELETE') then
    raise exception 'fixture: unexpected client INSERT/UPDATE/DELETE grants on contracts'; end if;
  if has_function_privilege('anon', 'public.require_read_committed(text)', 'EXECUTE') is distinct from
     has_function_privilege('authenticated', 'public.require_read_committed(text)', 'EXECUTE') then
    raise exception 'fixture: require_read_committed grants are inconsistent'; end if;
  raise notice 'fixture: policies, triggers, functions, owner and effective grants present';
end $$;
SQL
psql_local < supabase/migrations/20261118214020_entry_agent_credentials.sql
psql_local < supabase/migrations/20261120090000_create_entry_contract.sql
psql_local < tests/sql/create_entry_contract.sql
