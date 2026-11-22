#!/usr/bin/env bash
# Disposable local-only evidence for 20261122130000_events_v5_authority_columns
# (Codex T160 must-have 6). Requires the trustflow-localdb container; never
# targets a URL, never a hosted project.
#
# Fixture: the same fail-closed schema-only restore as
# tests/sql/create_entry_contract.sh (owners and ACLs kept, only the 7 reviewed
# platform event triggers left out), then row 1, A and B applied, so the
# database is at today's head. Legacy data is seeded through the real legacy
# writers BEFORE the migration; the migration is applied; then everything below
# is compared and every constraint is driven to its failure.
#
# v5 rows are written only inside transactions that are rolled back, after the
# `events_v5_writes_disabled` gate is dropped in that same transaction.
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${TF_FIXTURE_CONTAINER:-trustflow-localdb}"
db="trustflow_v5auth_$$"
dump="/tmp/${db}.dump"
work="$(mktemp -d "${TMPDIR:-/tmp}/trustflowv5auth.XXXXXX")"
cleanup() {
  docker exec "$container" dropdb -U supabase_admin --if-exists --force "$db" >/dev/null 2>&1 || echo "Could not drop disposable database $db" >&2
  docker exec "$container" rm -f "$dump" "$dump.list" || echo "Could not remove $dump in the container" >&2
  rm -rf "$work"
}
trap cleanup EXIT
psql_pg() { docker exec -i "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
psql_admin() { docker exec -i "$container" psql -X -qAt -U supabase_admin -d "$db" -v ON_ERROR_STOP=1 "$@"; }

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
echo 'fixture: applying row 1, A, B'
psql_pg -1 < supabase/migrations/20261118214020_entry_agent_credentials.sql
psql_pg -1 < supabase/migrations/20261120090000_create_entry_contract.sql
psql_pg -1 < supabase/migrations/20261120180000_close_contract_client_insert.sql
psql_pg -c "do \$\$ begin
  if exists (select 1 from pg_attribute where attrelid = 'public.events'::regclass and attname in ('credential_id','issuer_kind'))
  then raise exception 'fixture: authority columns already present'; end if; end \$\$;"

# ── Seed legacy data through the legacy writers (as service_role) ───────────
echo 'seed: legacy writers and direct v1–v4/null rows'
psql_admin <<'SQL'
create schema tf_evidence;
create table tf_evidence.kv (k text primary key, v text not null);
insert into auth.users (id, email, is_anonymous, email_confirmed_at) values
  ('99999999-9999-4999-8999-999999999999', 'v5owner@example.test', false, clock_timestamp()),
  ('88888888-8888-4888-8888-888888888888', 'v5guest@example.test', false, clock_timestamp());
insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy, invited_hirer_email,
                              invite_token, invite_token_expires_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '99999999-9999-4999-8999-999999999999', 'v5 auth seed', '["seed"]', 1,
   'guest@example.test', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', clock_timestamp() + interval '1 day'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '99999999-9999-4999-8999-999999999999', 'v5 auth legacy rows', '["seed"]', 1,
   'guest2@example.test', null, null),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '99999999-9999-4999-8999-999999999999', 'v5 auth after-migration accept', '["seed"]', 1,
   'guest3@example.test', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', clock_timestamp() + interval '1 day'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', '99999999-9999-4999-8999-999999999999', 'v5 auth fault matrix', '["seed"]', 1,
   'guest4@example.test', null, null);

-- A real, live grant on c1 for the guest's account: the legacy-RPC gate test
-- uses it so the v5 row it offers is complete and valid but for the gate.
insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, expires_at)
values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '88888888-8888-4888-8888-888888888888',
        'counterpart_account', encode(sha256('v5 seed grant'::bytea), 'hex'), array['payment.reported'],
        clock_timestamp() + interval '1 day');

-- Helpers shared by the seed and the after-migration writer checks.
create function tf_evidence.h(t text) returns text language sql immutable
  as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function tf_evidence.tip(c text) returns text language sql stable as $$
  select coalesce((select event_hash from public.events where contract_id = c and event_hash is not null
                   order by created_at desc, id desc limit 1), 'GENESIS') $$;
create function tf_evidence.ev(c text, typ text, actor text, prev text, extra jsonb default '{}') returns jsonb
  language sql volatile as $$
  select jsonb_build_object('id', gen_random_uuid(), 'type', typ, 'contract_id', c, 'actor_id', actor,
    'payload', '{}'::jsonb, 'created_at', clock_timestamp(), 'event_hash', tf_evidence.h(gen_random_uuid()::text),
    'prev_event_hash', prev, 'hash_version', 4, 'payload_hash', tf_evidence.h('{}'),
    'agreement_hash', tf_evidence.h('agreement'), 'dod_hash', tf_evidence.h('["seed"]')) || extra $$;
grant usage on schema tf_evidence to service_role;
grant execute on all functions in schema tf_evidence to service_role;
grant select, insert on tf_evidence.kv to service_role;

set role service_role;
do $$
declare
  c1 text := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  c2 text := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  r jsonb;
  xv text;
begin
  select xmin::text into xv from public.contracts where id = c1::uuid;
  r := public.accept_invitation('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'guest@example.test',
         'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', clock_timestamp() + interval '1 day', xv, 'GENESIS',
         tf_evidence.ev(c1, 'contract.accepted', 'guest:guest@example.test', 'GENESIS'));
  if r->>'status' <> 'accepted' then raise exception 'seed accept: %', r; end if;
  r := public.append_guest_event(c1::uuid, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', tf_evidence.tip(c1),
         tf_evidence.ev(c1, 'rating.submitted', 'guest:guest@example.test', tf_evidence.tip(c1)));
  if r->>'status' <> 'appended' then raise exception 'seed append: %', r; end if;
  r := public.reissue_guest_access(c1::uuid, '99999999-9999-4999-8999-999999999999',
         'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', clock_timestamp() + interval '1 day', tf_evidence.tip(c1),
         tf_evidence.ev(c1, 'access.reissued', 'owner', tf_evidence.tip(c1)));
  if r->>'status' is distinct from 'reissued' then raise exception 'seed reissue: %', r; end if;
  -- Direct rows for every legacy version shape, including a null version.
  insert into public.events (type, contract_id, actor_id, created_at, event_hash, prev_event_hash, hash_version)
  values ('note.v1', c2, 'owner', clock_timestamp(), tf_evidence.h('v1'), null, 1);
  insert into public.events (type, contract_id, actor_id, created_at, event_hash, prev_event_hash, hash_version)
  values ('note.v2', c2, 'owner', clock_timestamp(), tf_evidence.h('v2'), 'GENESIS', 2);
  insert into public.events (type, contract_id, actor_id, created_at, event_hash, prev_event_hash, hash_version, payload_hash)
  values ('note.v3', c2, 'owner', clock_timestamp(), tf_evidence.h('v3'), tf_evidence.h('v2'), 3, tf_evidence.h('{}'));
  insert into public.events (type, contract_id, actor_id, created_at, event_hash, prev_event_hash, hash_version)
  values ('note.null', c2, 'owner', clock_timestamp(), null, null, null);
end $$;
reset role;
SQL

# ── Snapshot: records, hashes, access surface ──────────────────────────────
snapshot() { # snapshot <label>
  psql_admin -v label="$1" <<'SQL'
insert into tf_evidence.kv
select :'label' || '.' || k, v from (
  select 'rows', count(*)::text from public.events
  union all select 'original_digest', md5(coalesce(string_agg((to_jsonb(e) - 'credential_id' - 'issuer_kind')::text, '|' order by id), ''))
    from public.events e
  union all select 'hash_digest', md5(coalesce(string_agg(coalesce(event_hash, '-') || ':' || coalesce(hash_version::text, '-'), '|' order by id), ''))
    from public.events
  union all select 'relacl', coalesce(relacl::text, '-') || ' rls=' || relrowsecurity || ' force=' || relforcerowsecurity
    from pg_class where oid = 'public.events'::regclass
  union all select 'old_column_acl', coalesce(string_agg(attname || '=' || coalesce(attacl::text, '-'), ',' order by attname), '')
    from pg_attribute where attrelid = 'public.events'::regclass and attnum > 0 and not attisdropped
      and attname not in ('credential_id', 'issuer_kind')
  union all select 'policies', coalesce(string_agg(polname || ':' || polcmd::text || ':' || polpermissive || ':' || polroles::regrole[]::text
      || ':' || coalesce(pg_get_expr(polqual, polrelid), '-') || ':' || coalesce(pg_get_expr(polwithcheck, polrelid), '-'), ',' order by polname), '')
    from pg_policy where polrelid = 'public.events'::regclass
  union all select 'rules', coalesce(string_agg(rulename || ':' || md5(pg_get_ruledef(oid)), ',' order by rulename), '')
    from pg_rewrite where ev_class = 'public.events'::regclass
  union all select 'triggers', coalesce(string_agg(tgname || ':' || tgenabled::text || ':' || tgfoid::regproc::text, ',' order by tgname), '')
    from pg_trigger where tgrelid = 'public.events'::regclass and not tgisinternal
  union all select 'table_privs', string_agg(r || ':' || p || '=' || has_table_privilege(r, 'public.events', p), ',' order by r, p)
    from unnest(array['anon', 'authenticated', 'public', 'service_role']) r,
         unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
  union all select 'old_column_privs', string_agg(r || ':' || a.attname || ':' || p || '=' || has_column_privilege(r, 'public.events', a.attname, p), ',' order by r, a.attname, p)
    from unnest(array['anon', 'authenticated', 'public', 'service_role']) r,
         unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p,
         pg_attribute a
    where a.attrelid = 'public.events'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attname not in ('credential_id', 'issuer_kind')
  union all select 'credential_table', coalesce(relacl::text, '-') || ' rls=' || relrowsecurity
    from pg_class where oid = 'public.entry_agent_credentials'::regclass
  union all select 'writer_functions', string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || p.prosecdef || ':'
      || coalesce(p.proacl::text, '-'), ',' order by p.oid::regprocedure::text)
    from pg_proc p where p.oid in ('public.accept_invitation(text,text,text,timestamptz,text,text,jsonb)'::regprocedure,
      'public.append_guest_event(uuid,text,text,jsonb)'::regprocedure,
      'public.reissue_guest_access(uuid,uuid,text,timestamptz,text,jsonb)'::regprocedure)
  union all select 'events_defaults', string_agg(a.attname || '=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ',' order by a.attname)
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.events'::regclass and a.attnum > 0 and not a.attisdropped
      and a.attname not in ('credential_id', 'issuer_kind')
  union all select 'indexes', string_agg(pg_get_indexdef(indexrelid), ',' order by indexrelid::regclass::text)
    from pg_index where indrelid = 'public.events'::regclass
) s(k, v);
SQL
}
snapshot before

# Existing credential test at the pre-FK stage: plain TRUNCATE must raise exactly TF008.
echo 'existing (baseline, before migration): tests/sql/entry_agent_credentials.sql'
psql_admin < tests/sql/entry_agent_credentials.sql > "$work/creds.before.out"

echo 'migration: applying 20261122130000_events_v5_authority_columns'
psql_pg -1 < supabase/migrations/20261122130000_events_v5_authority_columns.sql
snapshot after

# ── Checks ──────────────────────────────────────────────────────────────────
psql_admin <<'SQL'
create table tf_evidence.result (n serial, item text, label text, ok boolean, detail text);
grant insert, select on tf_evidence.result to service_role, postgres;
grant usage, select on sequence tf_evidence.result_n_seq to service_role, postgres;
grant usage on schema tf_evidence to postgres;
grant execute on all functions in schema tf_evidence to postgres;
create function tf_evidence.record(item text, label text, ok boolean, detail text default '') returns void
  language sql as $$ insert into tf_evidence.result (item, label, ok, detail) values (item, label, ok, detail) $$;
grant execute on function tf_evidence.record(text, text, boolean, text) to service_role, postgres, authenticated, anon;
grant usage on schema tf_evidence to authenticated, anon;
grant insert on tf_evidence.result to authenticated, anon;
grant usage on sequence tf_evidence.result_n_seq to authenticated, anon;

-- 1/3/6: before vs after
select tf_evidence.record('6', 'unchanged: ' || b.k, b.v = a.v, case when b.v = a.v then '' else 'before ' || left(b.v, 120) || ' / after ' || left(a.v, 120) end)
from (select substr(k, 8) k, v from tf_evidence.kv where k like 'before.%') b
join (select substr(k, 7) k, v from tf_evidence.kv where k like 'after.%') a using (k);
select tf_evidence.record('6', 'snapshot keys complete',
  (select count(*) from tf_evidence.kv where k like 'before.%') = 14
  and (select count(*) from tf_evidence.kv where k like 'after.%') = 14);
select tf_evidence.record('1', 'old rows read back null authority',
  not exists (select 1 from public.events where credential_id is not null or issuer_kind is not null)
  and (select count(*) from public.events) = 7, (select count(*)::text from public.events));
select tf_evidence.record('1', 'columns nullable, no default',
  (select count(*) from pg_attribute where attrelid = 'public.events'::regclass
     and attname in ('credential_id', 'issuer_kind') and not attnotnull and not atthasdef) = 2
  and (select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.events'::regclass and attname = 'credential_id') = 'uuid'
  and (select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.events'::regclass and attname = 'issuer_kind') = 'text');
select tf_evidence.record('1', 'FK names entry_agent_credentials ON DELETE RESTRICT, no cascade/set null',
  exists (select 1 from pg_constraint where conname = 'events_credential_id_fkey' and conrelid = 'public.events'::regclass
          and confrelid = 'public.entry_agent_credentials'::regclass and confdeltype = 'r' and confupdtype = 'a'));
select tf_evidence.record('2', 'constraints present and validated: ' || x,
  exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass and conname = x and convalidated))
from unnest(array['events_credential_id_fkey', 'events_issuer_kind_check', 'events_v5_authority_pair',
                  'events_v5_prev_link', 'events_v5_writes_disabled']) x;
select tf_evidence.record('3', 'new columns: same effective privileges as an existing column (' || r || ' ' || p || ')',
  has_column_privilege(r, 'public.events', c, p) = has_column_privilege(r, 'public.events', 'type', p),
  c || '=' || has_column_privilege(r, 'public.events', c, p))
from unnest(array['anon', 'authenticated', 'public', 'service_role']) r,
     unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p,
     unnest(array['credential_id', 'issuer_kind']) c;
select tf_evidence.record('3', 'no client write on new columns',
  not exists (select 1 from unnest(array['anon', 'authenticated', 'public']) r, unnest(array['credential_id', 'issuer_kind']) c,
              unnest(array['INSERT', 'UPDATE']) p where has_column_privilege(r, 'public.events', c, p)));
select tf_evidence.record('3', 'credential table still closed to clients',
  not exists (select 1 from unnest(array['anon', 'authenticated', 'public']) r
              where has_any_column_privilege(r, 'public.entry_agent_credentials', 'SELECT')
                 or has_table_privilege(r, 'public.entry_agent_credentials', 'SELECT')));
SQL

# Legacy writers after the migration, as service_role, with OLD payloads.
psql_admin <<'SQL'
set role service_role;
do $$
declare
  c1 text := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  c3 text := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  r jsonb; xv text; n int;
begin
  select xmin::text into xv from public.contracts where id = c3::uuid;
  r := public.accept_invitation('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', 'guest3@example.test',
         'cccccccc-cccc-4ccc-8ccc-ccccccccccc3', clock_timestamp() + interval '1 day', xv, 'GENESIS',
         tf_evidence.ev(c3, 'contract.accepted', 'guest:guest3@example.test', 'GENESIS'));
  perform tf_evidence.record('6', 'legacy accept_invitation still accepts an old payload', r->>'status' = 'accepted', r->>'status');
  r := public.append_guest_event(c1::uuid, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', tf_evidence.tip(c1),
         tf_evidence.ev(c1, 'rating.submitted', 'guest:guest@example.test', tf_evidence.tip(c1)));
  perform tf_evidence.record('6', 'legacy append_guest_event still appends an old payload', r->>'status' = 'appended', r->>'status');
  r := public.reissue_guest_access(c1::uuid, '99999999-9999-4999-8999-999999999999',
         'cccccccc-cccc-4ccc-8ccc-ccccccccccc4', clock_timestamp() + interval '1 day', tf_evidence.tip(c1),
         tf_evidence.ev(c1, 'access.reissued', 'owner', tf_evidence.tip(c1)));
  perform tf_evidence.record('6', 'legacy reissue_guest_access still reissues with an old payload', r->>'status' = 'reissued', r->>'status');
  select count(*) into n from public.events where contract_id in (c1, c3) and (credential_id is not null or issuer_kind is not null);
  perform tf_evidence.record('6', 'rows from legacy writers carry null authority', n = 0, n::text);

  -- A complete, otherwise valid v5 row offered through a legacy generic writer:
  -- a real live grant on this deal, the matching issuer kind, a real predecessor.
  -- Only the gate may refuse it: exactly 23514 on events_v5_writes_disabled, and
  -- nothing about the deal may change.
  declare
    before_ev text; before_ct text; after_ev text; after_ct text;
    st text; cn text; outcome text;
  begin
    select md5(coalesce(string_agg(to_jsonb(e)::text, '|' order by id), '')) into before_ev from public.events e where contract_id = c1;
    select md5(to_jsonb(c)::text) into before_ct from public.contracts c where id = c1::uuid;
    begin
      r := public.append_guest_event(c1::uuid, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4', tf_evidence.tip(c1),
             tf_evidence.ev(c1, 'rating.submitted', 'guest:guest@example.test', tf_evidence.tip(c1),
               jsonb_build_object('hash_version', 5, 'credential_id', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
                                  'issuer_kind', 'counterpart_account')));
      outcome := 'returned ' || coalesce(r::text, 'null');
    exception when others then
      get stacked diagnostics st = returned_sqlstate, cn = constraint_name;
      outcome := st || ':' || coalesce(nullif(cn, ''), '-');
    end;
    select md5(coalesce(string_agg(to_jsonb(e)::text, '|' order by id), '')) into after_ev from public.events e where contract_id = c1;
    select md5(to_jsonb(c)::text) into after_ct from public.contracts c where id = c1::uuid;
    perform tf_evidence.record('4', 'v5 (real grant) through legacy append_guest_event: exactly 23514 on events_v5_writes_disabled',
      outcome = '23514:events_v5_writes_disabled', outcome);
    perform tf_evidence.record('4', 'v5 through legacy append_guest_event: events and contract unchanged',
      before_ev = after_ev and before_ct = after_ct, before_ev || '/' || after_ev || ' ' || before_ct || '/' || after_ct);
  end;
end $$;
reset role;
SQL

# Fault matrix: postgres (table owner) inside one transaction that is rolled
# back. The v5 gate is dropped inside it so the shape constraints can be seen.
mark="$(psql_admin -c 'select coalesce(max(n), 0) from tf_evidence.result')"
psql_admin -v mark="$mark" > "$work/fault.tsv" <<'SQL'
begin;
insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, expires_at)
values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', '99999999-9999-4999-8999-999999999999',
        'owner_account', tf_evidence.h('secret'), array['performance.asserted'], clock_timestamp() + interval '1 day');

create function pg_temp.try(row_json jsonb) returns text language plpgsql as $$
declare cn text;
begin
  insert into public.events select * from jsonb_populate_record(null::public.events, row_json);
  return 'inserted';
exception when others then
  get stacked diagnostics cn = constraint_name;
  return sqlstate || ':' || coalesce(nullif(cn, ''), '-');
end $$;
create function pg_temp.base(v int, extra jsonb default '{}') returns jsonb language sql volatile as $$
  select jsonb_build_object('id', gen_random_uuid(), 'type', 'note.fault', 'contract_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
    'actor_id', 'owner', 'payload', '{}'::jsonb, 'created_at', clock_timestamp(),
    'event_hash', tf_evidence.h(gen_random_uuid()::text), 'prev_event_hash', tf_evidence.h(gen_random_uuid()::text),
    'hash_version', v) || extra $$;

-- Gate first, on a fully valid v5 row.
select tf_evidence.record('4', 'gate: a complete valid v5 row is refused while v5 writes are disabled',
  r = '23514:events_v5_writes_disabled', r)
from (select pg_temp.try(pg_temp.base(5, jsonb_build_object('credential_id', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
        'issuer_kind', 'owner_account', 'prev_event_hash', 'GENESIS'))) r) t;

alter table public.events drop constraint events_v5_writes_disabled;

-- Legacy and null versions with either or both authority values.
select tf_evidence.record('2', format('pair: version %s with %s is refused', coalesce(v::text, 'null'), label),
  r = '23514:events_v5_authority_pair', r)
from unnest(array[null, 1, 2, 3, 4, 6]::int[]) v,
     (values ('credential only', '{"credential_id":"dddddddd-dddd-4ddd-8ddd-ddddddddddd1"}'::jsonb),
             ('kind only', '{"issuer_kind":"owner_account"}'::jsonb),
             ('both', '{"credential_id":"dddddddd-dddd-4ddd-8ddd-ddddddddddd1","issuer_kind":"owner_account"}'::jsonb)) x(label, extra),
     lateral (select pg_temp.try(pg_temp.base(v, extra) || case when v is null then '{"hash_version":null}'::jsonb else '{}'::jsonb end) r) t;
-- v5 missing either or both.
select tf_evidence.record('2', 'pair: v5 with ' || label || ' is refused', r = '23514:events_v5_authority_pair', r)
from (values ('no credential', '{"issuer_kind":"owner_account"}'::jsonb),
             ('no kind', '{"credential_id":"dddddddd-dddd-4ddd-8ddd-ddddddddddd1"}'::jsonb),
             ('neither', '{}'::jsonb)) x(label, extra),
     lateral (select pg_temp.try(pg_temp.base(5, extra || '{"prev_event_hash":"GENESIS"}')) r) t;
-- Bad kinds.
select tf_evidence.record('2', 'kind: ' || quote_literal(k) || ' is refused', r = '23514:events_issuer_kind_check', r)
from unnest(array['owner', 'Owner_account', 'owner_account ', 'counterparty_account', '']) k,
     lateral (select pg_temp.try(pg_temp.base(5, jsonb_build_object('credential_id', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
       'issuer_kind', k, 'prev_event_hash', 'GENESIS'))) r) t;
-- Predecessor.
select tf_evidence.record('2', 'prev: v5 with ' || coalesce(quote_literal(p), 'null') || ' is refused', r = '23514:events_v5_prev_link', r)
from unnest(array[null, 'genesis', ' GENESIS', '', repeat('A', 64), repeat('0', 63), repeat('0', 65), repeat('g', 64)]) p,
     lateral (select pg_temp.try(pg_temp.base(5, jsonb_build_object('credential_id', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
       'issuer_kind', 'owner_account', 'prev_event_hash', p))) r) t;
-- Accepted syntax: GENESIS then a lowercase digest.
select tf_evidence.record('2', 'prev: v5 with GENESIS is accepted', r = 'inserted', r)
from (select pg_temp.try(pg_temp.base(5, jsonb_build_object('credential_id', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
        'issuer_kind', 'owner_account', 'prev_event_hash', 'GENESIS'))) r) t;
select tf_evidence.record('2', 'prev: v5 with a lowercase digest is accepted', r = 'inserted', r)
from (select pg_temp.try(pg_temp.base(5, jsonb_build_object('credential_id', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
        'issuer_kind', 'counterpart_account', 'prev_event_hash', repeat('a', 64)))) r) t;
-- Missing grant.
select tf_evidence.record('1', 'FK: v5 naming a nonexistent grant is refused', r = '23503:events_credential_id_fkey', r)
from (select pg_temp.try(pg_temp.base(5, jsonb_build_object('credential_id', gen_random_uuid(),
        'issuer_kind', 'owner_account', 'prev_event_hash', repeat('b', 64)))) r) t;
-- Legacy rows stay legal with null authority, including a null version.
select tf_evidence.record('1', 'legacy row with null authority is accepted (version ' || coalesce(v::text, 'null') || ')', r = 'inserted', r)
from unnest(array[null, 1, 2, 3, 4]::int[]) v,
     lateral (select pg_temp.try(pg_temp.base(v) || case when v is null then '{"hash_version":null}'::jsonb else '{}'::jsonb end) r) t;

-- Restricted delete: the TF008 trigger refuses first; with it disabled, the FK refuses.
create function pg_temp.del() returns text language plpgsql as $$
declare cn text;
begin
  delete from public.entry_agent_credentials where id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
  return 'deleted';
exception when others then
  get stacked diagnostics cn = constraint_name;
  return sqlstate || ':' || coalesce(nullif(cn, ''), '-');
end $$;
select tf_evidence.record('1', 'delete of a referenced grant: refused by the evidence trigger', pg_temp.del() = 'TF008:-', pg_temp.del());
alter table public.entry_agent_credentials disable trigger entry_agent_credentials_immutable;
select tf_evidence.record('1', 'delete of a referenced grant: refused by the FK on its own', pg_temp.del() = '23503:events_credential_id_fkey', pg_temp.del());

-- Print this transaction's results (the rollback below removes them), then undo every write above.
\pset fieldsep '\t'
select item, label, coalesce(ok::text, '\N'), coalesce(detail, '\N') from tf_evidence.result where n > :mark order by n;
rollback;
SQL

# Reload the printed fault results, then the facts that must hold after rollback.
grep $'\t' "$work/fault.tsv" > "$work/fault.rows" || { echo 'fault matrix printed no results' >&2; exit 1; }
psql_admin -c "\\copy tf_evidence.result (item, label, ok, detail) from pstdin" < "$work/fault.rows"
psql_admin <<'SQL'
select tf_evidence.record('6', 'after rollback: no v5 row and no authority value exists',
  not exists (select 1 from public.events where hash_version = 5 or credential_id is not null or issuer_kind is not null));
select tf_evidence.record('6', 'after rollback: gate and grant immutability trigger restored',
  exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass and conname = 'events_v5_writes_disabled' and convalidated)
  and exists (select 1 from pg_trigger where tgname = 'entry_agent_credentials_immutable' and tgenabled = 'O'));
SQL

# Clients denied direct mutation (no row is written: each statement fails).
for role in anon authenticated; do
psql_admin -v role="$role" <<'SQL'
set role :role;
do $$
declare st text; stmt text; n bigint;
begin
  foreach stmt in array array[
    'insert into public.events (type, contract_id, actor_id) values (''x.y'', ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'', ''owner'')',
    'insert into public.events (type, contract_id, actor_id, credential_id, issuer_kind) values (''x.y'', ''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'', ''owner'', gen_random_uuid(), ''owner_account'')',
    'update public.events set credential_id = gen_random_uuid()',
    'update public.events set issuer_kind = ''owner_account''',
    'delete from public.events',
    'truncate public.events',
    'select count(*) from public.entry_agent_credentials'] loop
    begin
      execute stmt;
      get diagnostics n = row_count;
      -- Existing behaviour: the no_update_events / no_delete_events rules turn a
      -- client UPDATE/DELETE into nothing rather than a privilege error.
      perform tf_evidence.record('3', current_user || ' no-op (rewrite rule), not a refusal: ' || left(stmt, 60),
        stmt ~ '^(update|delete) ' and n = 0, 'ran, rows affected ' || n);
    exception when others then
      get stacked diagnostics st = returned_sqlstate;
      perform tf_evidence.record('3', current_user || ' denied: ' || left(stmt, 60), st = '42501', st);
    end;
  end loop;
end $$;
reset role;
SQL
done

# Existing tests that cover the credential schema this migration references.
echo 'existing (migrated): tests/sql/entry_agent_credentials.sql'
psql_admin < tests/sql/entry_agent_credentials.sql > "$work/creds.out"
echo 'existing: tests/sql/entry_agent_credentials_inventory.sql'
psql_admin < tests/sql/entry_agent_credentials_inventory.sql > "$work/inventory.out" 2>&1
grep -i 'fail\|error' "$work/inventory.out" && { echo 'inventory reported a failure' >&2; exit 1; }
# set -e has stopped the run already if any of the three failed.
psql_admin <<'SQL'
select tf_evidence.record('6', 'existing entry_agent_credentials.sql passes before the migration (TF008 baseline)', true);
select tf_evidence.record('6', 'existing entry_agent_credentials.sql passes after the migration (0A000 + CASCADE TF008)', true);
select tf_evidence.record('6', 'existing entry_agent_credentials_inventory.sql passes after the migration', true);
SQL

# Migrated stage, with a real grant and events present: plain TRUNCATE exactly
# 0A000, CASCADE exactly TF008, and both tables byte-identical afterwards.
psql_admin <<'SQL'
do $$
declare
  g0 text; e0 text; g1 text; e1 text; st text; o1 text; o2 text;
begin
  select count(*) || ':' || md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by id), '')) into g0 from public.entry_agent_credentials g;
  select count(*) || ':' || md5(coalesce(string_agg(to_jsonb(e)::text, '|' order by id), '')) into e0 from public.events e;
  perform tf_evidence.record('1', 'migrated truncate: FK events_credential_id_fkey present',
    exists (select 1 from pg_constraint where conname = 'events_credential_id_fkey' and conrelid = 'public.events'::regclass
            and confrelid = 'public.entry_agent_credentials'::regclass and confdeltype = 'r'));
  perform tf_evidence.record('1', 'migrated truncate: fixture has a grant row', split_part(g0, ':', 1)::int > 0, g0);
  begin
    truncate public.entry_agent_credentials; o1 := 'succeeded';
  exception when others then get stacked diagnostics st = returned_sqlstate; o1 := st; end;
  begin
    truncate public.entry_agent_credentials cascade; o2 := 'succeeded';
  exception when others then get stacked diagnostics st = returned_sqlstate; o2 := st; end;
  select count(*) || ':' || md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by id), '')) into g1 from public.entry_agent_credentials g;
  select count(*) || ':' || md5(coalesce(string_agg(to_jsonb(e)::text, '|' order by id), '')) into e1 from public.events e;
  perform tf_evidence.record('1', 'migrated truncate: plain TRUNCATE refused with exactly 0A000', o1 = '0A000', o1);
  perform tf_evidence.record('1', 'migrated truncate: TRUNCATE CASCADE refused with exactly TF008', o2 = 'TF008', o2);
  perform tf_evidence.record('1', 'migrated truncate: grants and events unchanged after both', g0 = g1 and e0 = e1,
    g0 || ' -> ' || g1 || ' ; ' || e0 || ' -> ' || e1);
end $$;
SQL

echo
psql_admin <<'SQL'
\pset fieldsep ' '
select case when ok is true then 'PASS' else 'FAIL' end, '[' || item || ']', label,
       case when ok is true then '' else '-- ' || coalesce(detail, 'null detail') || case when ok is null then ' (null verdict)' else '' end end
from tf_evidence.result order by n;
select count(*) filter (where ok is true) || ' passed, ' || count(*) filter (where ok is not true) || ' failed' from tf_evidence.result;
do $$ begin
  if exists (select 1 from tf_evidence.result where ok is not true) then raise exception 'events_v5_authority: FAILED'; end if;
  if (select count(*) from tf_evidence.result) < 90 then raise exception 'events_v5_authority: too few checks recorded'; end if;
end $$;
SQL
echo 'events_v5_authority: ALL PASS'
