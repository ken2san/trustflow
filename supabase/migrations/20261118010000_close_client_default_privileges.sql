-- Close what the client roles get by default from `postgres`, and three
-- leftover table grants.
--
-- WHY (Task A0, read-only catalog audit of both projects, 2026-11-17)
-- Every object `postgres` created in schema public was, by default, granted to
-- `anon` and `authenticated`: all table privileges (arwdDxtm), sequence rwU,
-- function EXECUTE — and every function `postgres` created anywhere also got
-- the built-in EXECUTE for PUBLIC, which includes both roles. That default is
-- how contracts and earner_payout_profiles came to hold TRUNCATE (closed by
-- 20261117030000), and it would open the next table this project adds
-- (delegations) the same way unless its own migration remembered to revoke.
--
-- WHAT THIS CHANGES
-- 1. Defaults for objects `postgres` creates in schema public from now on:
--    nothing for anon or authenticated (tables, sequences, functions).
--    `service_role` keeps its default grants.
-- 2. ROLE-WIDE, NOT ONLY public: functions `postgres` creates in ANY schema no
--    longer get EXECUTE for PUBLIC. It cannot be scoped to public: per-schema
--    default privileges are added to the global ones, and a per-schema REVOKE
--    does not remove a globally granted privilege — measured on PostgreSQL
--    17.6 (Task 117): with only the per-schema revoke, a new public function
--    still carried =X/postgres and anon could execute it. Consequence: any
--    function `postgres` creates later, in any schema (including through a
--    CREATE EXTENSION run as `postgres`), is callable only by its owner and
--    whoever is granted it explicitly. Every function this project has created
--    lives in public or pg_temp; extensions here are installed by the platform
--    role, which this does not affect.
-- 3. earner_payout_profiles: anon/authenticated lose INSERT, UPDATE, DELETE.
--    RLS and its policies already refuse those rows; this removes the reliance
--    on RLS alone. Nothing in the app reads or writes this table.
-- 4. REFERENCES, TRIGGER and MAINTAIN on every existing public table and view,
--    from anon/authenticated. A table-level REVOKE also removes the same
--    privilege granted on individual columns (measured on PostgreSQL 17.6,
--    Task 119; documented behaviour), so column-level REFERENCES, and column
--    INSERT/UPDATE on earner_payout_profiles, go with the table-level revokes
--    here and in 3; the self-test checks the column level too. No client creates foreign keys or triggers or
--    needs LOCK/VACUUM/REINDEX; PostgREST and RLS use none of them. MAINTAIN is
--    PostgreSQL 17; on an older server the statement errors and the whole
--    migration rolls back.
--
-- WHAT THIS DOES NOT CHANGE, AND DOES NOT CLAIM
-- Existing grants other than those in 3 and 4 (the self-test below compares
-- every relation, column and default ACL before and after), RLS, policies,
-- function grants, service_role. Nor the defaults owned by `supabase_admin`:
-- `postgres` is neither superuser nor a member of it (A0), so it cannot alter
-- them. Objects that role creates in public can still default open to the
-- client roles — so not every new public object is closed, only those
-- `postgres` creates, which is every object this project's migrations create.
--
-- Idempotent: every statement is a revoke.

-- One view of every ACL this file could touch, read before and after so both
-- sides use the same logic. Each row carries grantor, grantee, privilege and
-- grant option, and the comparisons below are multisets (EXCEPT ALL), so a
-- changed grantor or a lost duplicate shows. postgres's global function default
-- has no stored row until something sets it; the built-in default it stands
-- for, acldefault('f', postgres), is used then.
-- NOT COVERED: relation ACLs and functions outside schema public, and default
-- ACLs are compared per entry, not as raw ACL text. Nothing here targets them.
create temp view tf_acl_now as
  select 'rel'::text as kind, c.oid::regclass::text as obj, ''::text as col,
         a.grantor, a.grantee, a.privilege_type, a.is_grantable
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl,
      acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'f', 'p', 'S')
  union all
  select 'col', c.oid::regclass::text, a2.attname, x.grantor, x.grantee, x.privilege_type, x.is_grantable
  from pg_attribute a2
  join pg_class c on c.oid = a2.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(a2.attacl) x
  where n.nspname = 'public' and a2.attnum > 0 and a2.attacl is not null
  union all
  select 'fn', p.oid::regprocedure::text, '', x.grantor, x.grantee, x.privilege_type, x.is_grantable
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) x
  where n.nspname = 'public'
  union all
  select 'defacl', pg_get_userbyid(d.defaclrole) || '/' || coalesce(n.nspname, '(global)') || '/' || d.defaclobjtype::text, '',
         x.grantor, x.grantee, x.privilege_type, x.is_grantable
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) x
  union all
  select 'defacl', 'postgres/(global)/f', '', x.grantor, x.grantee, x.privilege_type, x.is_grantable
  from aclexplode(acldefault('f'::"char", (select r.oid from pg_roles r where r.rolname = 'postgres'))) x
  where not exists (select 1 from pg_default_acl d
                    where d.defaclrole = (select r.oid from pg_roles r where r.rolname = 'postgres')
                      and d.defaclnamespace = 0 and d.defaclobjtype = 'f');

create temp table tf_acl_before on commit drop as select * from tf_acl_now;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;
alter default privileges for role postgres
  revoke execute on functions from public;

revoke insert, update, delete on table public.earner_payout_profiles from anon, authenticated;

revoke references, trigger, maintain on all tables in schema public from anon, authenticated;

-- Apply-time self-test. Every assertion failure raises TF901..TF905, which is
-- not caught: the whole migration rolls back with it. The Supabase CLI applies a
-- file and its history row as one implicitly transactional batch (ExecBatch,
-- one Sync) — read in the v2.105.0 source (Task 107) and proven with the real
-- CLI binary against a disposable PostgreSQL 17.6 (Task 118); `psql -1` too
-- (Task 117). No BEGIN/COMMIT in this file: a COMMIT inside the batch would
-- split the migration from its history row. The scratch objects in (4) are created in a
-- subtransaction that the sentinel TF999 undoes, so a passing run leaves none.
do $$
declare
  t record;
  r text;
  p text;
  v_anon oid := 'anon'::regrole;
  v_auth oid := 'authenticated'::regrole;
  v_unexpected bigint;
  v_missing bigint;
  v_suffix text := md5(clock_timestamp()::text || random()::text);
  v_tab text := 'tf_acl_probe_' || v_suffix;
  v_seq text := 'tf_acl_probe_seq_' || v_suffix;
  v_fn  text := 'tf_acl_probe_fn_' || v_suffix;
begin
  -- 1. Nothing revoked here is still held, effectively, on any public table or view.
  for t in
    select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
  loop
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['REFERENCES', 'TRIGGER', 'MAINTAIN', 'TRUNCATE'] loop
        if has_table_privilege(r, t.oid, p) then
          raise exception 'SELF-TEST FAILED: % still holds % on public.%', r, p, t.relname
            using errcode = 'TF901';
        end if;
      end loop;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(r, 'public.earner_payout_profiles', p) then
        raise exception 'SELF-TEST FAILED: % still holds % on public.earner_payout_profiles', r, p
          using errcode = 'TF901';
      end if;
    end loop;
    -- Column level: has_table_privilege does not see a column grant.
    foreach p in array array['INSERT', 'UPDATE'] loop
      if has_any_column_privilege(r, 'public.earner_payout_profiles', p) then
        raise exception 'SELF-TEST FAILED: % still holds column-level % on public.earner_payout_profiles', r, p
          using errcode = 'TF901';
      end if;
    end loop;
  end loop;
  for t in
    select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
  loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_any_column_privilege(r, t.oid, 'REFERENCES') then
        raise exception 'SELF-TEST FAILED: % still holds column-level REFERENCES on public.%', r, t.relname
          using errcode = 'TF901';
      end if;
    end loop;
  end loop;

  -- 2. Every relation, column and public-function ACL changed by exactly the
  --    targeted entries, compared as multisets with grantor and grant option:
  --    anon|authenticated × REFERENCES|TRIGGER|MAINTAIN on every public table and
  --    view (table and column level; not sequences), and anon|authenticated ×
  --    INSERT|UPDATE|DELETE on earner_payout_profiles. Everything else —
  --    service_role, sequences, function grants, the grants the app uses — is
  --    identical.
  create temp table tf_acl_expected on commit drop as
    select b.* from tf_acl_before b
    where not (b.kind in ('rel', 'col') and b.grantee in (v_anon, v_auth)
               and b.privilege_type in ('REFERENCES', 'TRIGGER', 'MAINTAIN')
               and exists (select 1 from pg_class c where c.oid::regclass::text = b.obj and c.relkind <> 'S'))
      and not (b.kind in ('rel', 'col') and b.grantee in (v_anon, v_auth)
               and b.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
               and b.obj = 'earner_payout_profiles')
      and not (b.kind = 'defacl' and b.obj like 'postgres/public/%' and b.grantee in (v_anon, v_auth))
      and not (b.kind = 'defacl' and b.obj = 'postgres/(global)/f'
               and b.grantee = 0 and b.privilege_type = 'EXECUTE');

  select count(*) into v_unexpected from (
    select * from tf_acl_now where kind <> 'defacl' except all select * from tf_acl_expected where kind <> 'defacl') d;
  select count(*) into v_missing from (
    select * from tf_acl_expected where kind <> 'defacl' except all select * from tf_acl_now where kind <> 'defacl') d;
  if v_unexpected > 0 or v_missing > 0 then
    raise exception 'SELF-TEST FAILED: relation/column/function ACLs changed beyond the targets (% unexpected, % missing)',
      v_unexpected, v_missing using errcode = 'TF902';
  end if;

  -- 3. Default ACLs changed by exactly: anon|authenticated removed from
  --    postgres's public entries, and exactly (PUBLIC, EXECUTE) removed from
  --    postgres's global function default — its other entries, grantors and
  --    grant options kept. supabase_admin's and every other default identical.
  select count(*) into v_unexpected from (
    select * from tf_acl_now where kind = 'defacl' except all select * from tf_acl_expected where kind = 'defacl') d;
  select count(*) into v_missing from (
    select * from tf_acl_expected where kind = 'defacl' except all select * from tf_acl_now where kind = 'defacl') d;
  if v_unexpected > 0 or v_missing > 0 then
    raise exception 'SELF-TEST FAILED: default ACLs changed beyond the targets (% unexpected, % missing)',
      v_unexpected, v_missing using errcode = 'TF903';
  end if;

  -- 4. The new defaults behave: a table, sequence and function created now by
  --    postgres are closed to the client roles and open to service_role.
  --    Random names; an existing object of that name stops the migration
  --    rather than being assumed absent.
  if to_regclass('public.' || v_tab) is not null or to_regclass('public.' || v_seq) is not null
     or exists (select 1 from pg_proc where proname = v_fn) then
    raise exception 'SELF-TEST FAILED: probe name collision' using errcode = 'TF905';
  end if;
  begin
    execute format('create table public.%I (id int)', v_tab);
    execute format('create sequence public.%I', v_seq);
    execute format('create function public.%I() returns int language sql set search_path = '''' as ''select 1''', v_fn);
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
        if has_table_privilege(r, format('public.%I', v_tab), p) then
          raise exception 'SELF-TEST FAILED: a new table grants % to %', p, r using errcode = 'TF904';
        end if;
      end loop;
      foreach p in array array['USAGE', 'SELECT', 'UPDATE'] loop
        if has_sequence_privilege(r, format('public.%I', v_seq), p) then
          raise exception 'SELF-TEST FAILED: a new sequence grants % to %', p, r using errcode = 'TF904';
        end if;
      end loop;
      if has_function_privilege(r, format('public.%I()', v_fn), 'EXECUTE') then
        raise exception 'SELF-TEST FAILED: a new function is executable by %', r using errcode = 'TF904';
      end if;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if not has_table_privilege('service_role', format('public.%I', v_tab), p) then
        raise exception 'SELF-TEST FAILED: a new table no longer grants % to service_role', p using errcode = 'TF904';
      end if;
    end loop;
    foreach p in array array['USAGE', 'SELECT', 'UPDATE'] loop
      if not has_sequence_privilege('service_role', format('public.%I', v_seq), p) then
        raise exception 'SELF-TEST FAILED: a new sequence no longer grants % to service_role', p using errcode = 'TF904';
      end if;
    end loop;
    if not has_function_privilege('service_role', format('public.%I()', v_fn), 'EXECUTE') then
      raise exception 'SELF-TEST FAILED: a new function is not executable by service_role' using errcode = 'TF904';
    end if;
    raise exception 'probe done' using errcode = 'TF999';
  exception when sqlstate 'TF999' then
    null;  -- the scratch objects are rolled back with this subtransaction
  end;
  drop view tf_acl_now;
end
$$;
