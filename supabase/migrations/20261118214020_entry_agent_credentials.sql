-- Step 2 only. No existing path consumes a delegation in this migration.
-- The edge issuance gate must stay off until delegated access is enforced.
alter table public.contracts add column counterpart_account_id uuid references auth.users(id);
alter table public.contracts add constraint counterpart_not_owner
  check (counterpart_account_id is null or counterpart_account_id <> earner_user_id);
revoke insert (counterpart_account_id), update (counterpart_account_id) on public.contracts from anon, authenticated;

create table public.entry_agent_credentials (
  id uuid primary key,
  contract_id uuid not null references public.contracts(id),
  issuer_id uuid not null references auth.users(id),
  issuer_kind text not null check (issuer_kind in ('owner_account', 'counterpart_account')),
  secret_hash text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  invite_hash text check (invite_hash is null or invite_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (isfinite(expires_at)),
  check (expires_at > created_at),
  -- A technical cap, not a product term: a grant is reissued, never open-ended.
  check (expires_at <= created_at + interval '30 days'),
  check (cardinality(scopes) > 0),
  check (scopes <@ array['read', 'accept', 'performance.asserted', 'performance.accepted',
    'performance.rejected', 'payment.reported', 'payment.acknowledged', 'payment.disputed']::text[]),
  check (issuer_kind <> 'owner_account' or not ('accept' = any(scopes)))
);
alter table public.entry_agent_credentials enable row level security;
revoke all on public.entry_agent_credentials from public, anon, authenticated;
revoke all on public.entry_agent_credentials from service_role;
grant select on public.entry_agent_credentials to service_role;

-- The database owner can alter enforcement; ordinary roles cannot rewrite or
-- remove grant evidence, even if table privileges are accidentally broadened.
create function public.protect_entry_agent_credential_evidence()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'credential grant evidence cannot be deleted' using errcode = 'TF008';
  end if;
  if (to_jsonb(new) - 'revoked_at') is distinct from (to_jsonb(old) - 'revoked_at')
    or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
    or (old.revoked_at is null and new.revoked_at is not null and not isfinite(new.revoked_at)) then
    raise exception 'credential grant evidence is immutable' using errcode = 'TF008';
  end if;
  return new;
end $$;
create trigger entry_agent_credentials_immutable
  before update or delete on public.entry_agent_credentials
  for each row execute function public.protect_entry_agent_credential_evidence();
create trigger entry_agent_credentials_no_truncate
  before truncate on public.entry_agent_credentials
  for each statement execute function public.protect_entry_agent_credential_evidence();

-- Preserve the existing READ COMMITTED and event checks. Both issuance and
-- deletion hold the contract lock before checking grant evidence.
create or replace function public.refuse_delete_of_contract_with_evidence()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_read_committed('deleting an agreement');
  perform 1 from public.contracts c where c.id = old.id for update;
  if exists (select 1 from public.entry_agent_credentials d where d.contract_id = old.id) then
    raise exception 'contract % has credential grants and cannot be deleted', old.id
      using errcode = 'TF007', hint = 'Credential grant evidence must be retained, even after expiry or revocation.';
  end if;
  if exists (select 1 from public.events e where e.contract_id = old.id::text) then
    raise exception 'contract % carries evidence and cannot be deleted', old.id
      using errcode = 'TF004', hint = 'evidence was appended while this delete was in flight; the agreement is now part of the record';
  end if;
  return old;
end $$;

-- Only the edge function, after getUser, passes an issuer id. The database
-- independently checks account verification and deal binding under the lock.
create function public.issue_entry_agent_credential(
  p_id uuid, p_contract_id uuid, p_issuer_id uuid, p_issuer_kind text,
  p_secret_hash text, p_scopes text[], p_expires_at timestamptz, p_invite text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.contracts%rowtype;
  u auth.users%rowtype;
  v_invite_hash text := null;
  v_now timestamptz;
begin
  perform public.require_read_committed('issuing a credential');
  select * into c from public.contracts where id = p_contract_id for update;
  if not found then return jsonb_build_object('status', 'not_authorized'); end if;
  select * into u from auth.users where id = p_issuer_id for share;
  if not found or u.is_anonymous is distinct from false or u.email_confirmed_at is null then
    return jsonb_build_object('status', 'not_authorized');
  end if;
  v_now := clock_timestamp();
  if p_id is null or p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$'
    or p_expires_at is null or not isfinite(p_expires_at) or p_expires_at <= v_now
    or p_expires_at > v_now + interval '30 days'
    or p_scopes is null or cardinality(p_scopes) = 0
    or array_position(p_scopes, null) is not null
    or not (p_scopes <@ array['read','accept','performance.asserted','performance.accepted',
       'performance.rejected','payment.reported','payment.acknowledged','payment.disputed']::text[])
    or cardinality(p_scopes) <> (select count(distinct x) from unnest(p_scopes) as s(x)) then
    return jsonb_build_object('status', 'invalid_grant');
  end if;
  if p_issuer_kind = 'owner_account' then
    if c.earner_user_id is distinct from p_issuer_id or 'accept' = any(p_scopes) then
      return jsonb_build_object('status', 'not_authorized');
    end if;
  elsif p_issuer_kind = 'counterpart_account' then
    if c.earner_user_id = p_issuer_id then return jsonb_build_object('status', 'not_authorized'); end if;
    if c.invite_token_used_at is null then
      if p_invite is null or c.invite_token::text is distinct from p_invite
        or c.invite_token_expires_at is null or c.invite_token_expires_at <= v_now
        or u.email is null or c.invited_hirer_email is null
        or btrim(u.email) = '' or btrim(c.invited_hirer_email) = ''
        or lower(btrim(u.email)) <> lower(btrim(c.invited_hirer_email)) then
        return jsonb_build_object('status', 'not_authorized');
      end if;
      v_invite_hash := encode(pg_catalog.sha256(pg_catalog.convert_to(p_invite, 'UTF8')), 'hex');
    elsif c.counterpart_account_id is distinct from p_issuer_id then
      return jsonb_build_object('status', 'not_authorized');
    end if;
  else
    return jsonb_build_object('status', 'not_authorized');
  end if;
  insert into public.entry_agent_credentials
    (id, contract_id, issuer_id, issuer_kind, secret_hash, invite_hash, scopes, created_at, expires_at)
  values (p_id, p_contract_id, p_issuer_id, p_issuer_kind, p_secret_hash, v_invite_hash, p_scopes, v_now, p_expires_at);
  return jsonb_build_object('status','issued', 'id',p_id, 'contract_id',p_contract_id,
    'issuer_id',p_issuer_id, 'issuer_kind',p_issuer_kind, 'scopes',p_scopes, 'expires_at',p_expires_at);
end $$;

create function public.revoke_entry_agent_credential(p_contract_id uuid, p_id uuid, p_issuer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.contracts%rowtype; d public.entry_agent_credentials%rowtype;
begin
  select * into c from public.contracts where id = p_contract_id for update;
  if not found then return jsonb_build_object('status','not_authorized'); end if;
  select * into d from public.entry_agent_credentials
    where id = p_id and contract_id = p_contract_id for update;
  if not found or d.issuer_id is distinct from p_issuer_id then
    return jsonb_build_object('status','not_authorized');
  end if;
  update public.entry_agent_credentials set revoked_at = coalesce(revoked_at, clock_timestamp()) where id = p_id;
  return jsonb_build_object('status','revoked');
end $$;
create function public.list_entry_agent_credentials(p_contract_id uuid, p_issuer_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'contract_id', d.contract_id, 'issuer_kind', d.issuer_kind,
    'scopes', d.scopes, 'created_at', d.created_at, 'expires_at', d.expires_at,
    'revoked_at', d.revoked_at) order by d.created_at), '[]'::jsonb)
  from public.entry_agent_credentials d
  where d.contract_id = p_contract_id and d.issuer_id = p_issuer_id
$$;
revoke all on function public.issue_entry_agent_credential(uuid,uuid,uuid,text,text,text[],timestamptz,text) from public, anon, authenticated;
revoke all on function public.revoke_entry_agent_credential(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.list_entry_agent_credentials(uuid,uuid) from public, anon, authenticated;
grant execute on function public.issue_entry_agent_credential(uuid,uuid,uuid,text,text,text[],timestamptz,text) to service_role;
grant execute on function public.revoke_entry_agent_credential(uuid,uuid,uuid) to service_role;
grant execute on function public.list_entry_agent_credentials(uuid,uuid) to service_role;

-- Apply-time self-test on the real catalog, in the style of 20261118010000.
-- A failure raises TF911..TF914, uncaught, so the CLI's one-batch apply rolls
-- the whole migration back. TF901..TF905 belong to that earlier file.
-- PostgREST and pg_graphql run each request as anon or authenticated, so they
-- can reach no more than these effective privileges (role membership and
-- PUBLIC included). service_role, the owner and superusers stay trusted.
do $$
declare
  r text;
  p text;
  f text;
  v_bad text;
  v_rpcs text[] := array[
    'public.issue_entry_agent_credential(uuid,uuid,uuid,text,text,text[],timestamptz,text)',
    'public.revoke_entry_agent_credential(uuid,uuid,uuid)',
    'public.list_entry_agent_credentials(uuid,uuid)'];
begin
  -- 1. The credential table: nothing for the client roles or PUBLIC, SELECT only for service_role.
  foreach r in array array['anon', 'authenticated', 'public'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      if has_table_privilege(r, 'public.entry_agent_credentials', p) then
        raise exception 'SELF-TEST FAILED: % holds % on entry_agent_credentials', r, p using errcode = 'TF911';
      end if;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
      if has_any_column_privilege(r, 'public.entry_agent_credentials', p) then
        raise exception 'SELF-TEST FAILED: % holds column-level % on entry_agent_credentials', r, p using errcode = 'TF911';
      end if;
    end loop;
  end loop;
  if not has_table_privilege('service_role', 'public.entry_agent_credentials', 'SELECT') then
    raise exception 'SELF-TEST FAILED: service_role cannot read entry_agent_credentials' using errcode = 'TF911';
  end if;
  foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
    if has_table_privilege('service_role', 'public.entry_agent_credentials', p)
       or (p in ('INSERT', 'UPDATE') and has_any_column_privilege('service_role', 'public.entry_agent_credentials', p)) then
      raise exception 'SELF-TEST FAILED: service_role holds % on entry_agent_credentials', p using errcode = 'TF911';
    end if;
  end loop;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.entry_agent_credentials'::regclass) then
    raise exception 'SELF-TEST FAILED: RLS is off on entry_agent_credentials' using errcode = 'TF911';
  end if;

  -- 2. Only the server binds a counterpart account.
  foreach r in array array['anon', 'authenticated', 'public'] loop
    foreach p in array array['INSERT', 'UPDATE'] loop
      if has_column_privilege(r, 'public.contracts', 'counterpart_account_id', p) then
        raise exception 'SELF-TEST FAILED: % may % contracts.counterpart_account_id', r, p using errcode = 'TF912';
      end if;
    end loop;
  end loop;

  -- 3. The three RPCs: service_role only, SECURITY DEFINER with an empty search_path.
  foreach f in array v_rpcs loop
    foreach r in array array['anon', 'authenticated', 'public'] loop
      if has_function_privilege(r, f, 'EXECUTE') then
        raise exception 'SELF-TEST FAILED: % may execute %', r, f using errcode = 'TF913';
      end if;
    end loop;
    if not has_function_privilege('service_role', f, 'EXECUTE')
       or not (select p2.prosecdef and 'search_path=""' = any(p2.proconfig) from pg_proc p2 where p2.oid = f::regprocedure) then
      raise exception 'SELF-TEST FAILED: % is not a service_role SECURITY DEFINER with empty search_path', f using errcode = 'TF913';
    end if;
  end loop;
  -- Issuance locks the issuer row FOR SHARE, which needs UPDATE on auth.users.
  -- Without it every issuance would fail; fail the apply instead (held on E2E, Task 149).
  if not has_any_column_privilege(
       (select pg_get_userbyid(p2.proowner) from pg_proc p2 where p2.oid = v_rpcs[1]::regprocedure), 'auth.users', 'UPDATE') then
    raise exception 'SELF-TEST FAILED: the issuance owner cannot lock auth.users rows' using errcode = 'TF913';
  end if;

  -- 4. No side door. Every function body, view and rule outside the system
  --    schemas is scanned: only the five functions in this file may name the
  --    credential table or the counterpart column. A body that builds either
  --    name dynamically is not detected. Trigger functions are included, since
  --    a BEFORE trigger can set a column whatever the column grants say.
  select string_agg(p2.oid::regprocedure::text, ', ') into v_bad
  from pg_proc p2 join pg_namespace n on n.oid = p2.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and (p2.prosrc ilike '%entry_agent_credentials%' or p2.prosrc ilike '%counterpart_account_id%')
    and p2.oid not in (select x::regprocedure from unnest(v_rpcs || array[
      'public.protect_entry_agent_credential_evidence()',
      'public.refuse_delete_of_contract_with_evidence()']) as x);
  if v_bad is not null then
    raise exception 'SELF-TEST FAILED: unexpected functions name the credential table or counterpart column: %', v_bad
      using errcode = 'TF914';
  end if;
  select string_agg(format('%I.%I', w.schemaname, w.rulename), ', ') into v_bad
  from pg_rules w
  where w.schemaname not in ('pg_catalog', 'information_schema')
    and (w.definition ilike '%entry_agent_credentials%' or w.definition ilike '%counterpart_account_id%');
  if v_bad is null then
    select string_agg(c.oid::regclass::text, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('v', 'm') and n.nspname not in ('pg_catalog', 'information_schema')
      and (pg_get_viewdef(c.oid) ilike '%entry_agent_credentials%' or pg_get_viewdef(c.oid) ilike '%counterpart_account_id%');
  end if;
  if v_bad is not null then
    raise exception 'SELF-TEST FAILED: a view or rule names the credential table or counterpart column: %', v_bad
      using errcode = 'TF914';
  end if;
  -- pg_graphql is not installed on either project (Task 115). If it ever is,
  -- its entry points must run as the caller, not as their owner.
  select string_agg(p2.oid::regprocedure::text, ', ') into v_bad
  from pg_extension e
  join pg_depend d on d.refclassid = 'pg_extension'::regclass and d.refobjid = e.oid
    and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
  join pg_proc p2 on p2.oid = d.objid
  where e.extname = 'pg_graphql' and p2.prosecdef
    and (has_function_privilege('anon', p2.oid, 'EXECUTE') or has_function_privilege('authenticated', p2.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'SELF-TEST FAILED: pg_graphql exposes SECURITY DEFINER entry points: %', v_bad using errcode = 'TF914';
  end if;
end
$$;
