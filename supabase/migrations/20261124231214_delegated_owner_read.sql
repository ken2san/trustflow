-- Row 5a: delegated owner read (docs/plans/row5-owner-read.md §5a).
--
-- One service-role RPC authorizes a live owner-issued `read` grant and
-- materializes a bounded snapshot of one deal under the same locks, so a read
-- and a revoke serialize on the contract row: whichever commits first wins.
-- No table, grant scope, event field, RLS path or gate change. The row 4
-- resolver and its six-operation allowlist are untouched: `read` gets its own
-- helper with the same lock order and status vocabulary.

-- Read authority under locks. Lock order is the row 4 order: contract FOR
-- UPDATE, then the grant FOR SHARE (revoke takes contract then grant FOR
-- UPDATE). The clock is sampled once, after both locks, so expiry is never
-- decided before a lock wait. Read has no gate and no performer/receiver rule.
create function private.resolve_owner_read_grant(
  p_contract_id uuid, p_credential_id uuid, p_secret_hash text
) returns table (status text, issuer_id uuid, now timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  c public.contracts%rowtype;
  d public.entry_agent_credentials%rowtype;
  v_now timestamptz;
begin
  perform public.require_read_committed('resolving a delegated read');
  if p_contract_id is null or p_credential_id is null
     or p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    return query select 'malformed'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select * into c from public.contracts k where k.id = p_contract_id for update;
  if not found then
    return query select 'grant_unknown'::text, null::uuid, null::timestamptz;
    return;
  end if;
  select * into d from public.entry_agent_credentials g
    where g.id = p_credential_id and g.contract_id = c.id for share;
  v_now := pg_catalog.clock_timestamp();

  status := case
    when d.id is null or d.contract_id <> c.id then 'grant_unknown'
    when d.secret_hash <> p_secret_hash then 'secret_mismatch'
    when d.issuer_kind <> 'owner_account' then 'issuer_kind'
    when c.earner_user_id is distinct from d.issuer_id then 'issuer_not_owner'
    when d.revoked_at is not null then 'revoked'
    when d.expires_at <= v_now then 'expired'
    when not ('read' = any(d.scopes)) then 'scope'
    else 'ok'
  end;
  if status = 'ok' then issuer_id := d.issuer_id; end if;
  now := v_now;
  return next;
end $$;
revoke all on function private.resolve_owner_read_grant(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- The owner read. Returns {status} alone on any refusal: no projected field,
-- count or receipt material precedes or follows a failed authorization.
--
-- Order: READ COMMITTED; the lock-free possession precheck (so a wrong deal,
-- missing grant or wrong hash never waits on the deal lock); the locked
-- authority decision; then, still under both locks, one materialization.
--
-- The event slice, its exact total, the cap, the tail marker and the first
-- acceptance anchor come from ONE statement, so they share one snapshot under
-- READ COMMITTED. Order is (created_at, id). The slice is a prefix: at most
-- 500 events and at most 1 MiB of projected event JSON, cut at a row boundary.
--
-- Projection, not `select *`:
--   contract: the fields the current agreement snapshot is built from (with the
--     legacy amount for snapshot parity), plus id and state. No contact, invite,
--     guest-access, payment-provider or account fields.
--   event: the v5 canonical inputs, event_hash, whether a timestamp token
--     exists (never the token), and a filtered payload: per-type statement keys
--     (the guest allowlist without contact addresses), the recorded authority
--     metadata the receipt reports, and `_agreement` on acceptance events only
--     (the offline acceptance anchor). No idempotency key, raw payload or
--     server-only column.
create function public.read_delegated_owner_deal(
  p_contract_id uuid, p_credential_id uuid, p_secret_hash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_cap_events constant int := 500;
  v_cap_bytes constant bigint := 1048576;
  -- Statement keys per event type: the guest allowlist (guestEventView.ts
  -- PAYLOAD_ALLOWLIST) minus `counterparty_email`. An unknown type gets none.
  v_statement constant jsonb := '{
    "contract.initiated": ["step", "title", "budgetPoints"],
    "contract.accepted": ["step"],
    "performance.asserted": ["step", "note"],
    "performance.accepted": ["step", "note"],
    "performance.rejected": ["step", "reason"],
    "work.submitted": ["step"],
    "work.approved": ["step"],
    "work.rejected": ["step", "reason"],
    "contract.cancelled": ["reason"],
    "contract.completed": [],
    "dod.consent_recorded": ["counterparty_name", "dod_items"],
    "dispute.opened": ["reason"],
    "rating.submitted": ["rating"],
    "access.reissued": [],
    "payment.reported": ["note"],
    "payment.acknowledged": ["note"],
    "payment.disputed": ["note"]
  }';
  v_meta constant text[] := array['_actor_role', '_role_in_agreement', '_auth_method',
    '_authentication', '_claimed_identity_verified'];
  v_status text;
  v_now timestamptz;
  v_contract jsonb;
  v_events jsonb;
  v_total bigint;
  v_returned bigint;
  v_tail jsonb;
  v_anchor jsonb;
begin
  perform public.require_read_committed('reading a deal under a delegated grant');
  v_status := private.v5_grant_precheck(p_contract_id, p_credential_id, p_secret_hash);
  if v_status <> 'ok' then
    return jsonb_build_object('status', v_status);
  end if;

  select r.status, r.now into v_status, v_now
    from private.resolve_owner_read_grant(p_contract_id, p_credential_id, p_secret_hash) r;
  if v_status is distinct from 'ok' then
    return jsonb_build_object('status', coalesce(v_status, 'grant_unknown'));
  end if;

  -- The contract row is held FOR UPDATE by this transaction.
  select jsonb_build_object(
      'id', k.id, 'state', k.state, 'project_name', k.project_name, 'dod', k.dod,
      'amount_minor', k.amount_minor, 'amount_jpy', k.amount_jpy, 'currency', k.currency,
      'deadline', k.deadline, 'performed_by', k.performed_by,
      'earner_display_name', k.earner_display_name)
    into v_contract
    from public.contracts k where k.id = p_contract_id;

  with projected as (
    select e.id, e.type, e.event_hash, e.created_at,
      jsonb_build_object(
        'id', e.id, 'type', e.type, 'contract_id', e.contract_id, 'actor_id', e.actor_id,
        'dod_hash', e.dod_hash, 'created_at', e.created_at, 'prev_event_hash', e.prev_event_hash,
        'payload_hash', e.payload_hash, 'agreement_hash', e.agreement_hash,
        'hash_version', e.hash_version, 'credential_id', e.credential_id,
        'issuer_kind', e.issuer_kind, 'event_hash', e.event_hash,
        'timestamp_token_present', e.tsa_token is not null,
        'payload', (
          select coalesce(jsonb_object_agg(k, e.payload -> k), '{}'::jsonb)
          from jsonb_object_keys(case when jsonb_typeof(e.payload) = 'object' then e.payload else '{}'::jsonb end) k
          where k = any(v_meta)
             or (k = '_agreement' and e.type = 'contract.accepted')
             or (left(k, 1) <> '_' and coalesce(v_statement -> e.type, '[]'::jsonb) ? k))
      ) as j
    from public.events e
    where e.contract_id = p_contract_id::text
  ), ordered as (
    select p.*,
      row_number() over w as rn,
      count(*) over () as total,
      sum(octet_length(p.j::text)) over w as cum
    from projected p
    window w as (order by p.created_at, p.id rows between unbounded preceding and current row)
  ), marked as (
    select o.*, (o.rn <= v_cap_events and o.cum <= v_cap_bytes) as included from ordered o
  )
  select
    coalesce(jsonb_agg(m.j order by m.rn) filter (where m.included), '[]'::jsonb),
    coalesce(max(m.total), 0),
    count(*) filter (where m.included),
    (array_agg(jsonb_build_object('id', m.id, 'event_hash', m.event_hash) order by m.rn desc)
       filter (where m.included))[1],
    (array_agg(jsonb_build_object('event_id', m.id, 'sequence', m.rn - 1, 'in_prefix', m.included) order by m.rn)
       filter (where m.type = 'contract.accepted'))[1]
  into v_events, v_total, v_returned, v_tail, v_anchor
  from marked m;

  return jsonb_build_object(
    'status', 'ok',
    'authorized_at', v_now,
    'contract', v_contract,
    'events', v_events,
    'read_boundary', jsonb_build_object(
      'order', 'created_at,id',
      'total_count', v_total,
      'returned_count', v_returned,
      'truncated', v_returned < v_total,
      'cap_events', v_cap_events,
      'cap_bytes', v_cap_bytes,
      'tail', v_tail,
      'acceptance_anchor', v_anchor));
end $$;
revoke all on function public.read_delegated_owner_deal(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.read_delegated_owner_deal(uuid, uuid, text) to service_role;

-- Apply-time self-test. A failure raises TF941..TF942, uncaught, so a one-batch
-- apply rolls the whole migration back.
do $$
declare
  r text;
  v_rpc constant text := 'public.read_delegated_owner_deal(uuid,uuid,text)';
  v_helper constant text := 'private.resolve_owner_read_grant(uuid,uuid,text)';
begin
  foreach r in array array['anon', 'authenticated', 'public'] loop
    if has_function_privilege(r, v_rpc, 'EXECUTE') then
      raise exception 'SELF-TEST FAILED: % may execute the owner read RPC', r using errcode = 'TF941';
    end if;
  end loop;
  if not has_function_privilege('service_role', v_rpc, 'EXECUTE') then
    raise exception 'SELF-TEST FAILED: service_role cannot execute the owner read RPC' using errcode = 'TF941';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'public'] loop
    if has_function_privilege(r, v_helper, 'EXECUTE') then
      raise exception 'SELF-TEST FAILED: % may execute the read helper', r using errcode = 'TF941';
    end if;
  end loop;
  if exists (select 1 from pg_proc p where p.oid in (v_rpc::regprocedure, v_helper::regprocedure)
             and (not p.prosecdef or not ('search_path=""' = any(coalesce(p.proconfig, '{}'))))) then
    raise exception 'SELF-TEST FAILED: a read function is not SECURITY DEFINER with an empty search_path'
      using errcode = 'TF942';
  end if;
end
$$;
