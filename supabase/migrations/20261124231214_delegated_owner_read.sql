-- Row 5a: delegated owner read (docs/plans/row5-owner-read.md §5a).
--
-- One service-role RPC authorizes a live owner-issued `read` grant and
-- materializes a bounded snapshot of one deal under the same locks, so a read
-- and a revoke serialize on the contract row: whichever transaction takes the
-- contract lock first decides, and it holds that lock through its commit.
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

-- Statement keys per event type: the guest allowlist (guestEventView.ts
-- PAYLOAD_ALLOWLIST) minus `counterparty_email`, its only contact field. An
-- unknown type gets none. A function, not a literal inside the RPC, so the
-- parity test can compare it with the TypeScript table.
create function private.owner_read_statement_keys() returns jsonb
language sql immutable set search_path = '' as $$
  select '{
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
  }'::jsonb
$$;

-- An acceptance snapshot crosses only if it is exactly buildSnapshotV1's shape:
-- its eight keys and guestEventView.ts SNAPSHOT_VALUE_RULES[1]. Ordered IFs,
-- because jsonb_object_keys raises on a non-object.
create function private.owner_read_snapshot_ok(s jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if s is null or jsonb_typeof(s) <> 'object' then return false; end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(s) k) is distinct from
       array['amount', 'currency', 'deadline', 'dod', 'offered_by', 'performed_by', 'project_name', 'snapshot_version'] then
    return false;
  end if;
  if s->'snapshot_version' is distinct from '1'::jsonb
     or jsonb_typeof(s->'project_name') not in ('string', 'null')
     or jsonb_typeof(s->'dod') <> 'array'
     or jsonb_typeof(s->'currency') not in ('string', 'null')
     or jsonb_typeof(s->'offered_by') not in ('string', 'null')
     or s->'performed_by' not in ('"creator"'::jsonb, '"counterparty"'::jsonb) then
    return false;
  end if;
  if exists (select 1 from jsonb_array_elements(s->'dod') x where jsonb_typeof(x) <> 'string') then
    return false;
  end if;
  if jsonb_typeof(s->'amount') = 'number' then
    if (s->>'amount')::numeric <> trunc((s->>'amount')::numeric)
       or abs((s->>'amount')::numeric) > 9007199254740991 then
      return false;
    end if;
  elsif jsonb_typeof(s->'amount') <> 'null' then
    return false;
  end if;
  if jsonb_typeof(s->'deadline') = 'string' then
    return s->>'deadline' ~ '^\d{4}-\d{2}-\d{2}$';
  end if;
  return jsonb_typeof(s->'deadline') = 'null';
end $$;

-- A recorded assurance crosses only if its keys are among assuranceForRecord's
-- (authAssurance.ts; older rows carry fewer) and every value is a scalar.
create function private.owner_read_authentication_ok(a jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if a is null or jsonb_typeof(a) <> 'object' then return false; end if;
  return not exists (
    select 1 from jsonb_each(a) x
     where x.key not in ('assurance', 'credential', 'method', 'aal', 'seconds_since_authentication',
                         'recent_authentication', 'recent_authentication_window_seconds',
                         'act_bound_authentication', 'act_binding_mechanism')
        or jsonb_typeof(x.value) not in ('string', 'number', 'boolean', 'null'));
end $$;

-- The payload an owner read may carry, and which recorded fields were withheld
-- at the boundary. A field is passed verbatim or omitted; it is never rewritten,
-- so nothing shown can stand in for hashed evidence it does not match.
-- `withheld` names only those boundary decisions, never an unlisted party key
-- (a key name is content too).
create function private.owner_read_payload(p_type text, p_payload jsonb, out payload jsonb, out withheld text[])
language plpgsql immutable set search_path = '' as $$
declare
  v_keys jsonb := coalesce(private.owner_read_statement_keys() -> p_type, '[]'::jsonb);
  x record;
  v_ok boolean;
begin
  payload := '{}'::jsonb;
  withheld := '{}';
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then return; end if;
  for x in select * from jsonb_each(p_payload) loop
    v_ok := null;
    if left(x.key, 1) <> '_' then
      if v_keys ? x.key then payload := payload || jsonb_build_object(x.key, x.value); end if;
    elsif x.key in ('_actor_role', '_role_in_agreement', '_auth_method') then
      v_ok := jsonb_typeof(x.value) = 'string';
    elsif x.key = '_claimed_identity_verified' then
      v_ok := jsonb_typeof(x.value) = 'boolean';
    elsif x.key = '_authentication' then
      v_ok := private.owner_read_authentication_ok(x.value);
    elsif x.key = '_agreement' and p_type = 'dod.consent_recorded' then
      -- The accepted snapshot, on the acceptance act only.
      v_ok := private.owner_read_snapshot_ok(x.value);
    end if;
    if v_ok then
      payload := payload || jsonb_build_object(x.key, x.value);
    elsif not v_ok then
      withheld := withheld || ('payload.' || x.key);
    end if;
  end loop;
end $$;

revoke all on function private.owner_read_statement_keys() from public, anon, authenticated, service_role;
revoke all on function private.owner_read_snapshot_ok(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.owner_read_authentication_ok(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.owner_read_payload(text, jsonb) from public, anon, authenticated, service_role;

-- The owner read. Returns {status} alone on any refusal: no projected field,
-- count or receipt material precedes or follows a failed authorization.
--
-- Order: READ COMMITTED; the lock-free possession precheck (so a wrong deal,
-- missing grant or wrong hash never waits on the deal lock); the locked
-- authority decision; then, still under both locks, one materialization.
--
-- The event slice, its exact total, the cap, the tail marker and the
-- acceptance anchor come from ONE statement, so they share one snapshot under
-- READ COMMITTED. Order is (created_at, id). The total and the anchor read a
-- narrow row set; only the first 500 rows are projected. The slice is a prefix
-- of at most 500 events whose event array, as jsonb text (brackets and ", "
-- separators included), is at most 1 MiB, cut at a row boundary. jsonb text is
-- never shorter than compact JSON, so the bound holds for that encoding too.
--
-- The acceptance is `dod.consent_recorded` (eventRecord.ts ACCEPTANCE_TYPE);
-- the anchor is the first one in (created_at, id) order, the row
-- append_delegated_event reads the accepted version from.
--
-- Projection, not `select *`:
--   contract: the fields the current agreement snapshot is built from (with the
--     legacy amount for snapshot parity), plus id and state. No contact, invite,
--     guest-access, payment-provider or account fields.
--   event: the canonical inputs, event_hash, whether a timestamp token exists
--     (never the token) and the payload from owner_read_payload. `actor_id` is
--     carried only when it is an account UUID: a legacy guest actor is
--     `guest:<address>`, a contact address the no-contact rule withholds. Such
--     an event lists "actor_id" in `withheld` and has
--     canonical_inputs_complete = false: its hash cannot be recomputed from
--     this read, and nothing here substitutes a value that would claim it can.
--     No idempotency key, raw payload or server-only column.
create function public.read_delegated_owner_deal(
  p_contract_id uuid, p_credential_id uuid, p_secret_hash text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_cap_events constant int := 500;
  v_cap_bytes constant bigint := 1048576;
  v_status text;
  v_now timestamptz;
  v_contract jsonb;
  v_events jsonb;
  v_total bigint;
  v_returned bigint;
  v_bytes bigint;
  v_tail jsonb;
  v_anchor_id uuid;
  v_anchor_rn bigint;
  v_acceptances bigint;
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

  with base as (
    select e.id, e.type, row_number() over (order by e.created_at, e.id) as rn, count(*) over () as total
      from public.events e
     where e.contract_id = p_contract_id::text
  ), projected as (
    select b.rn, e.id, e.event_hash,
      jsonb_build_object(
        'id', e.id, 'type', e.type, 'contract_id', e.contract_id,
        'dod_hash', e.dod_hash, 'created_at', e.created_at, 'prev_event_hash', e.prev_event_hash,
        'payload_hash', e.payload_hash, 'agreement_hash', e.agreement_hash,
        'hash_version', e.hash_version, 'credential_id', e.credential_id,
        'issuer_kind', e.issuer_kind, 'event_hash', e.event_hash,
        'timestamp_token_present', e.tsa_token is not null,
        'payload', p.payload,
        'canonical_inputs_complete', a.ok,
        'withheld', to_jsonb(array(select w from unnest(
            case when a.ok then '{}'::text[] else array['actor_id'] end || p.withheld) w order by w collate "C")))
      || case when a.ok then jsonb_build_object('actor_id', e.actor_id) else '{}'::jsonb end as j
      from base b
      join public.events e on e.id = b.id
      cross join lateral private.owner_read_payload(e.type, e.payload) p
      cross join lateral (select coalesce(e.actor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) as ok) a
     where b.rn <= v_cap_events
  ), sized as (
    -- Running length of the array text: each element plus its ", " separator;
    -- the "[" and "]" stand in for the one separator the last element lacks.
    select s.*, sum(octet_length(s.j::text) + 2) over (order by s.rn) as cum from projected s
  ), kept as (
    select * from sized where cum <= v_cap_bytes
  ), first_acceptance as (
    select b.id, b.rn from base b where b.type = 'dod.consent_recorded' order by b.rn limit 1
  )
  select
    (select coalesce(jsonb_agg(k.j order by k.rn), '[]'::jsonb) from kept k),
    (select count(*) from base),
    (select count(*) from kept),
    (select coalesce(max(k.cum), 2) from kept k),
    (select jsonb_build_object('id', k.id, 'event_hash', k.event_hash) from kept k order by k.rn desc limit 1),
    (select f.id from first_acceptance f),
    (select f.rn from first_acceptance f),
    (select count(*) from base b where b.type = 'dod.consent_recorded')
  into v_events, v_total, v_returned, v_bytes, v_tail, v_anchor_id, v_anchor_rn, v_acceptances;

  return jsonb_build_object(
    'status', 'ok',
    'authorized_at', v_now,
    'contract', v_contract,
    'events', v_events,
    'read_boundary', jsonb_build_object(
      'order', 'created_at,id',
      'total_count', v_total,
      'returned_count', v_returned,
      'returned_bytes', v_bytes,
      'truncated', v_returned < v_total,
      'cap_events', v_cap_events,
      'cap_bytes', v_cap_bytes,
      'tail', v_tail,
      'acceptance_count', v_acceptances,
      'acceptance_anchor', case when v_anchor_id is null then null else jsonb_build_object(
        'event_id', v_anchor_id, 'sequence', v_anchor_rn - 1, 'in_prefix', v_anchor_rn <= v_returned) end));
end $$;
revoke all on function public.read_delegated_owner_deal(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.read_delegated_owner_deal(uuid, uuid, text) to service_role;

-- Apply-time self-test. A failure raises TF941..TF942, uncaught, so a one-batch
-- apply rolls the whole migration back.
do $$
declare
  r text;
  f text;
  v_rpc constant text := 'public.read_delegated_owner_deal(uuid,uuid,text)';
  v_private constant text[] := array['private.resolve_owner_read_grant(uuid,uuid,text)',
    'private.owner_read_statement_keys()', 'private.owner_read_snapshot_ok(jsonb)',
    'private.owner_read_authentication_ok(jsonb)', 'private.owner_read_payload(text,jsonb)'];
begin
  foreach r in array array['anon', 'authenticated', 'public'] loop
    if has_function_privilege(r, v_rpc, 'EXECUTE') then
      raise exception 'SELF-TEST FAILED: % may execute the owner read RPC', r using errcode = 'TF941';
    end if;
  end loop;
  if not has_function_privilege('service_role', v_rpc, 'EXECUTE') then
    raise exception 'SELF-TEST FAILED: service_role cannot execute the owner read RPC' using errcode = 'TF941';
  end if;
  foreach f in array v_private loop
    foreach r in array array['anon', 'authenticated', 'service_role', 'public'] loop
      if has_function_privilege(r, f, 'EXECUTE') then
        raise exception 'SELF-TEST FAILED: % may execute %', r, f using errcode = 'TF941';
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_proc p where p.oid in (v_rpc::regprocedure, v_private[1]::regprocedure)
             and (not p.prosecdef or not ('search_path=""' = any(coalesce(p.proconfig, '{}'))))) then
    raise exception 'SELF-TEST FAILED: a read function is not SECURITY DEFINER with an empty search_path'
      using errcode = 'TF942';
  end if;
  if exists (select 1 from unnest(v_private[2:]) h(sig) join pg_proc p on p.oid = h.sig::regprocedure
             where not ('search_path=""' = any(coalesce(p.proconfig, '{}')))) then
    raise exception 'SELF-TEST FAILED: a projection helper has a non-empty search_path' using errcode = 'TF942';
  end if;
end
$$;
