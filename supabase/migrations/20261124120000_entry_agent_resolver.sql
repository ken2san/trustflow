-- Row 4a: the shared delegated-grant resolver, in an unexposed schema, and the
-- v5 write gate it reads. Nothing here writes an event or opens v5: the gate is
-- created closed, no client or service_role path can reach the resolver, and
-- `events_v5_writes_disabled` is untouched. The writer RPCs that call the
-- resolver arrive in the next migration (docs/plans/row4-owner-append.md §4b).

create schema private;
revoke all on schema private from public, anon, authenticated, service_role;

-- The operator's switch for v5 writes. A singleton: `id` can only be true.
-- Opening and closing are single-row updates by the owner; nothing else
-- references the row except the resolver and (later) the v5 write triggers.
create table private.v5_write_gate (
  id boolean primary key default true check (id),
  open boolean not null default false
);
revoke all on private.v5_write_gate from public, anon, authenticated, service_role;
insert into private.v5_write_gate (id, open) values (true, false);

-- A missing gate fails closed, but the row should never go missing.
create function private.protect_v5_write_gate()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'the v5 write gate row cannot be removed' using errcode = 'TF009';
end $$;
revoke all on function private.protect_v5_write_gate() from public, anon, authenticated, service_role;
create trigger v5_write_gate_no_delete
  before delete on private.v5_write_gate
  for each row execute function private.protect_v5_write_gate();
create trigger v5_write_gate_no_truncate
  before truncate on private.v5_write_gate
  for each statement execute function private.protect_v5_write_gate();

-- Resolves an `x-trustflow-grant` for one operation on one deal, under locks.
--
-- Lock order: contract FOR UPDATE (re-entrant when the calling writer already
-- holds it, as it must), then the grant FOR SHARE, then for an append the gate
-- FOR SHARE. Revoke takes contract then grant, so the two serialize on the
-- contract row, and an operator close locks only the gate row: no cycle.
--
-- The clock is read exactly once, after the last lock is granted, so no expiry
-- decision can be taken before a lock wait. That sample is returned for the
-- writer's created-at window.
--
-- Every refusal is an internal status for the redacted log line; the HTTP layer
-- answers all of them with one 403 (gate states with one 503).
create function private.resolve_entry_agent_grant(
  p_contract_id uuid, p_credential_id uuid, p_secret_hash text, p_operation text, p_for_insert boolean
) returns table (status text, issuer_id uuid, issuer_kind text, now timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  c public.contracts%rowtype;
  d public.entry_agent_credentials%rowtype;
  v_gate_open boolean;
  v_now timestamptz;
  -- Row 4 admits performance and payment claims only: no `read`, no `accept`.
  v_allowlist constant text[] := array['performance.asserted', 'performance.accepted', 'performance.rejected',
    'payment.reported', 'payment.acknowledged', 'payment.disputed'];
begin
  -- The re-reads below are only fresh under READ COMMITTED.
  perform public.require_read_committed('resolving a delegated grant');
  if p_contract_id is null or p_credential_id is null or p_operation is null or p_for_insert is null
     or p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    return query select 'malformed'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  select * into c from public.contracts k where k.id = p_contract_id for update;
  if not found then
    return query select 'grant_unknown'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;
  -- Matching the deal here means another deal's grant is never locked.
  select * into d from public.entry_agent_credentials g
    where g.id = p_credential_id and g.contract_id = c.id for share;
  if p_for_insert then
    select w.open into v_gate_open from private.v5_write_gate w where w.id for share;
  end if;
  v_now := pg_catalog.clock_timestamp();

  status := case
    when d.id is null or d.contract_id <> c.id then 'grant_unknown'
    when d.secret_hash <> p_secret_hash then 'secret_mismatch'
    when d.issuer_kind <> 'owner_account' then 'issuer_kind'
    when c.earner_user_id is distinct from d.issuer_id then 'issuer_not_owner'
    when d.revoked_at is not null then 'revoked'
    when d.expires_at <= v_now then 'expired'
    when not (p_operation = any(d.scopes)) then 'scope'
    when not (p_operation = any(v_allowlist)) then 'allowlist'
    when p_for_insert and v_gate_open is null then 'gate_missing'
    when p_for_insert and not v_gate_open then 'gate_closed'
    else 'ok'
  end;
  if status = 'ok' then
    issuer_id := d.issuer_id;
    issuer_kind := d.issuer_kind;
  end if;
  now := v_now;
  return next;
end $$;
revoke all on function private.resolve_entry_agent_grant(uuid, uuid, text, text, boolean)
  from public, anon, authenticated, service_role;

-- Apply-time self-test. A failure raises TF921..TF923, uncaught, so a one-batch
-- apply rolls the whole migration back. TF911..TF914 belong to 20261118214020.
do $$
declare
  r text;
  p text;
  f constant text := 'private.resolve_entry_agent_grant(uuid,uuid,text,text,boolean)';
begin
  -- 1. No client role, PUBLIC or service_role may use or create in `private`.
  foreach r in array array['anon', 'authenticated', 'service_role', 'public'] loop
    foreach p in array array['USAGE', 'CREATE'] loop
      if has_schema_privilege(r, 'private', p) then
        raise exception 'SELF-TEST FAILED: % holds % on schema private', r, p using errcode = 'TF921';
      end if;
    end loop;
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(r, 'private.v5_write_gate', p) then
        raise exception 'SELF-TEST FAILED: % holds % on private.v5_write_gate', r, p using errcode = 'TF921';
      end if;
    end loop;
    -- 2. The resolver and the guard: owner only.
    if has_function_privilege(r, f, 'EXECUTE')
       or has_function_privilege(r, 'private.protect_v5_write_gate()', 'EXECUTE') then
      raise exception 'SELF-TEST FAILED: % may execute a private function', r using errcode = 'TF922';
    end if;
  end loop;
  -- Null-safe: a missing row, a missing setting or a false flag all fail.
  if (select p2.prosecdef and 'search_path=""' = any(p2.proconfig) from pg_proc p2 where p2.oid = f::regprocedure)
     is distinct from true then
    raise exception 'SELF-TEST FAILED: the resolver is not SECURITY DEFINER with an empty search_path'
      using errcode = 'TF922';
  end if;
  -- 3. The gate is a single closed row.
  if (select count(*) from private.v5_write_gate) <> 1 or (select open from private.v5_write_gate) then
    raise exception 'SELF-TEST FAILED: the v5 write gate is not one closed row' using errcode = 'TF923';
  end if;
end
$$;
