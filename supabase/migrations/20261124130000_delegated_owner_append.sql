-- Row 4b: the delegated owner append (docs/plans/row4-owner-append.md §4b, and
-- the §4c write tickets and triggers that confine v5 inserts to this writer).
--
-- v5 WRITES STAY IMPOSSIBLE after this migration. `events_v5_writes_disabled`
-- is untouched, the gate row (20261124120000) stays closed, and log-event's
-- ENTRY_DELEGATED_APPEND flag is off. Each of the three refuses on its own.
-- Migration C drops the CHECK only after the staged proofs (§4c).
--
-- Lock order, the same everywhere: the contract FOR UPDATE, then the grant FOR
-- SHARE, then (append only) the gate FOR SHARE, all through the resolver, then
-- one clock sample. Every check below reads rows under those locks.

-- ── One-use write tickets ───────────────────────────────────────────────────
-- The writer issues one ticket for the event id it is about to insert, in the
-- same transaction. The BEFORE trigger marks it used; the AFTER trigger, which
-- sees the row as finally stored, requires a used ticket and deletes it. Any
-- other path to a v5-shaped row (a direct service-role insert, a legacy writer
-- built on jsonb_populate_record) has no ticket and is refused.
create table private.v5_write_tickets (
  txid bigint not null,
  event_id uuid not null,
  used boolean not null default false,
  primary key (txid, event_id)
);
revoke all on private.v5_write_tickets from public, anon, authenticated, service_role;

-- ── Pure helpers ────────────────────────────────────────────────────────────

-- The created-at window: within the 60 s before the single post-lock clock
-- sample, both ends inclusive, and strictly after the chain tip.
create function private.v5_created_at_ok(p_created_at timestamptz, p_now timestamptz, p_tip timestamptz)
returns boolean language sql immutable set search_path = '' as $$
  select p_created_at is not null and p_now is not null
     and p_created_at >= p_now - interval '60 seconds'
     and p_created_at <= p_now
     and (p_tip is null or p_created_at > p_tip)
$$;

-- What `_authentication` must be for a delegated write: grant possession, no
-- login, no authentication age. Equal to assuranceForRecord(grantAssurance())
-- in _shared/authAssurance.ts; tests/unit/delegatedEvent.test.js pins both.
create function private.v5_grant_authentication()
returns jsonb language sql immutable set search_path = '' as $$
  select '{"assurance":"bearer_capability","credential":"entry_agent_grant","method":null,"aal":null,
    "seconds_since_authentication":null,"recent_authentication":false,
    "recent_authentication_window_seconds":300,"act_bound_authentication":false,
    "act_binding_mechanism":null}'::jsonb
$$;

-- The reserved payload fields, in the order that keeps a role mismatch from
-- ever reading as staleness (Codex T191 should-fix 1):
--   1. well-formed, with no reference to locked state, else
--      'reserved_fields_mismatch' (even when the context is also stale);
--   2. fresh: the proposed performed_by equals the locked one, else
--      'context_changed';
--   3. 'ok'. Authorization under the locked role is the writer's next step.
create function private.v5_reserved_fields_status(p_payload jsonb, p_proposed text, p_locked text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_payload is null or jsonb_typeof(p_payload) <> 'object' then 'reserved_fields_mismatch'
    when (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p_payload) k where left(k, 1) = '_')
         is distinct from array['_actor_role', '_auth_method', '_authentication', '_role_in_agreement']
      then 'reserved_fields_mismatch'
    when p_payload->'_actor_role' is distinct from '"earner"'::jsonb then 'reserved_fields_mismatch'
    when p_payload->'_auth_method' is distinct from '"entry_agent_grant"'::jsonb then 'reserved_fields_mismatch'
    when p_payload->'_authentication' is distinct from private.v5_grant_authentication() then 'reserved_fields_mismatch'
    when p_proposed is null or p_proposed not in ('creator', 'counterparty') then 'reserved_fields_mismatch'
    when p_payload->'_role_in_agreement' is distinct from
         to_jsonb(case p_proposed when 'counterparty' then 'receiver' else 'performer' end)
      then 'reserved_fields_mismatch'
    when p_locked is distinct from p_proposed then 'context_changed'
    else 'ok'
  end
$$;

-- The v5 outer canonical, byte-identical to buildEventCanonicalV5: fixed key
-- order, compact JSON, every value a validated ASCII token or null. Callers
-- validate the shapes first; this only assembles.
create function private.v5_outer_canonical(
  p_id uuid, p_type text, p_contract_id uuid, p_actor_id uuid, p_dod_hash text, p_created_at timestamptz,
  p_prev_hash text, p_payload_hash text, p_agreement_hash text, p_credential_id uuid, p_issuer_kind text
) returns text language sql immutable set search_path = '' as $$
  select '{"domain":"trustflow.event","hash_version":5'
    || ',"id":"' || p_id::text || '"'
    || ',"type":"' || p_type || '"'
    || ',"contract_id":"' || p_contract_id::text || '"'
    || ',"actor_id":"' || p_actor_id::text || '"'
    || ',"dod_hash":"' || p_dod_hash || '"'
    || ',"created_at":"' || to_char(p_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '"'
    || ',"prev_hash":"' || p_prev_hash || '"'
    || ',"payload_hash":"' || p_payload_hash || '"'
    || ',"agreement_hash":' || coalesce('"' || p_agreement_hash || '"', 'null')
    || ',"credential_id":"' || p_credential_id::text || '"'
    || ',"issuer_kind":"' || p_issuer_kind || '"}'
$$;

revoke all on function private.v5_created_at_ok(timestamptz, timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.v5_grant_authentication() from public, anon, authenticated, service_role;
revoke all on function private.v5_reserved_fields_status(jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function private.v5_outer_canonical(uuid, text, uuid, uuid, text, timestamptz, text, text, text, uuid, text)
  from public, anon, authenticated, service_role;

-- ── The trigger pair ────────────────────────────────────────────────────────
-- Both are SECURITY DEFINER, so an inserting role without access to `private`
-- sees the intended SQLSTATE rather than 42501 (Codex T189). EXECUTE is checked
-- when a trigger is created, not when it fires, and a trigger function cannot
-- be called outside a trigger, so revoking it borrows nothing.

-- BEFORE: early, observable refusals. Ticket first, so ticket denial shows
-- even while the gate is closed; then the gate under a share lock.
create function private.v5_write_ticket_check()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_open boolean;
begin
  if not exists (select 1 from private.v5_write_tickets t
                 where t.txid = pg_catalog.txid_current() and t.event_id = new.id and not t.used) then
    raise exception 'v5 event % has no write ticket', new.id using errcode = 'TF011';
  end if;
  select w.open into v_open from private.v5_write_gate w where w.id for share;
  if not found then
    raise exception 'the v5 write gate row is missing' using errcode = 'TF012';
  end if;
  if not v_open then
    raise exception 'v5 writes are closed' using errcode = 'TF013';
  end if;
  update private.v5_write_tickets t set used = true
   where t.txid = pg_catalog.txid_current() and t.event_id = new.id;
  return new;
end $$;

-- AFTER: the enforcement. It sees the row as stored, after every BEFORE
-- trigger whatever its name, so a later trigger that rewrites a legacy insert
-- into v5 still finds no used ticket. One ticket is one row.
create function private.v5_write_ticket_confirm()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from private.v5_write_tickets t
   where t.txid = pg_catalog.txid_current() and t.event_id = new.id and t.used;
  if not found then
    raise exception 'v5 event % was stored without a used write ticket', new.id using errcode = 'TF014';
  end if;
  return null;
end $$;

revoke all on function private.v5_write_ticket_check() from public, anon, authenticated, service_role;
revoke all on function private.v5_write_ticket_confirm() from public, anon, authenticated, service_role;

create trigger zz_v5_write_ticket_check
  before insert on public.events
  for each row
  when (new.hash_version is not distinct from 5 or new.credential_id is not null or new.issuer_kind is not null)
  execute function private.v5_write_ticket_check();
create trigger v5_write_ticket_confirm
  after insert on public.events
  for each row
  when (new.hash_version is not distinct from 5 or new.credential_id is not null or new.issuer_kind is not null)
  execute function private.v5_write_ticket_confirm();

-- ── The writer ──────────────────────────────────────────────────────────────
-- p_event: exactly the keys id, type, contract_id, actor_id, dod_hash,
--   created_at, prev_event_hash, payload, payload_hash, agreement_hash,
--   event_hash, idempotency_key. Never credential_id or issuer_kind: those come
--   from the resolved grant.
-- p_performed_by: the typed proposal Edge built the reserved fields from.
-- p_hashed_inputs: {"dod": <the DoD Edge hashed>, "agreement": <the snapshot
--   Edge hashed, or null on a draft>}. SQL compares the inputs with the locked
--   rows; the inner digests themselves are the trusted caller's (pushback 1).
create function public.append_delegated_event(
  p_contract_id uuid, p_credential_id uuid, p_secret_hash text,
  p_performed_by text, p_hashed_inputs jsonb, p_event jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.contracts%rowtype;
  g record;
  v_status text;
  v_type text := p_event->>'type';
  v_id uuid;
  v_actor uuid;
  v_created_at timestamptz;
  v_tip public.events%rowtype;
  v_prev text;
  v_existing public.events%rowtype;
  v_owner_role text;
  v_required_role text;
  v_accepted_version text;
  v_row public.events%rowtype;
  v_key text := p_event->>'idempotency_key';
begin
  perform public.require_read_committed('append_delegated_event');

  -- Shape first, with no lock: a malformed proposal is never an authorization
  -- question. The keys are exact so no authority field can ride along.
  if p_event is null or jsonb_typeof(p_event) <> 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p_event) k) is distinct from
        array['actor_id', 'agreement_hash', 'contract_id', 'created_at', 'dod_hash', 'event_hash',
              'id', 'idempotency_key', 'payload', 'payload_hash', 'prev_event_hash', 'type']
     or coalesce(p_event->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(p_event->>'actor_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_event->>'contract_id' is distinct from p_contract_id::text
     or coalesce(v_type, '') !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
     or coalesce(p_event->>'dod_hash', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_event->>'payload_hash', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_event->>'event_hash', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_event->>'prev_event_hash', '') !~ '^([0-9a-f]{64}|GENESIS)$'
     or (p_event->'agreement_hash' <> 'null'::jsonb and coalesce(p_event->>'agreement_hash', '') !~ '^[0-9a-f]{64}$')
     or coalesce(p_event->>'created_at', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
     or jsonb_typeof(p_event->'payload') is distinct from 'object'
     or (p_event->'idempotency_key' <> 'null'::jsonb and jsonb_typeof(p_event->'idempotency_key') <> 'string')
     or p_hashed_inputs is null or jsonb_typeof(p_hashed_inputs) <> 'object'
     or not (p_hashed_inputs ? 'dod') or not (p_hashed_inputs ? 'agreement') then
    return jsonb_build_object('status', 'binding_mismatch');
  end if;
  v_id := (p_event->>'id')::uuid;
  v_actor := (p_event->>'actor_id')::uuid;
  begin
    v_created_at := (p_event->>'created_at')::timestamptz;
  exception when others then
    return jsonb_build_object('status', 'binding_mismatch');
  end;
  -- Round-trips to the exact string Edge hashed, or it is not v5-canonical.
  if to_char(v_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p_event->>'created_at' then
    return jsonb_build_object('status', 'binding_mismatch');
  end if;

  select * into c from public.contracts k where k.id = p_contract_id for update;
  if not found then
    return jsonb_build_object('status', 'grant_unknown');
  end if;
  select * into g from private.resolve_entry_agent_grant(p_contract_id, p_credential_id, p_secret_hash, v_type, true);
  if g.status <> 'ok' then
    return jsonb_build_object('status', g.status);
  end if;

  -- Reserved fields: well-formed, then fresh.
  v_status := private.v5_reserved_fields_status(p_event->'payload', p_performed_by, c.performed_by);
  if v_status <> 'ok' then
    return jsonb_build_object('status', v_status);
  end if;

  -- Authorization under the LOCKED role, as on the owner path (ROLE_REQUIRED
  -- in log-event). The resolver's allowlist already confines the type to these
  -- six; state rules stay with the insert triggers.
  v_owner_role := case c.performed_by when 'counterparty' then 'receiver' else 'performer' end;
  v_required_role := case v_type
    when 'performance.asserted' then 'performer' when 'payment.acknowledged' then 'performer'
    when 'payment.disputed' then 'performer'
    when 'performance.accepted' then 'receiver' when 'performance.rejected' then 'receiver'
    when 'payment.reported' then 'receiver' end;
  if v_required_role is null or v_required_role <> v_owner_role then
    return jsonb_build_object('status', 'wrong_party_for_event_type');
  end if;

  -- The tip, ordered as every other writer reads it.
  select * into v_tip from public.events e
   where e.contract_id = c.id::text and e.event_hash is not null
   order by e.created_at desc, e.id desc limit 1;

  if not private.v5_created_at_ok(v_created_at, g.now, v_tip.created_at) then
    return jsonb_build_object('status', 'clock_window');
  end if;

  -- Twin: a retry of this grant's own operation is answered with its row.
  if v_key is not null then
    select * into v_existing from public.events e
     where e.contract_id = c.id::text and e.idempotency_key = v_key;
    if found then
      if v_existing.type = v_type and v_existing.actor_id = g.issuer_id::text
         and v_existing.credential_id is not distinct from p_credential_id then
        return jsonb_build_object('status', 'replayed', 'event', to_jsonb(v_existing));
      end if;
      return jsonb_build_object('status', 'idempotency_key_in_use');
    end if;
  end if;

  -- Binding: every preimage field against the locked rows.
  v_prev := coalesce(v_tip.event_hash, 'GENESIS');
  if p_event->>'prev_event_hash' is distinct from v_prev then
    return jsonb_build_object('status', 'chain_conflict');
  end if;
  if v_actor is distinct from g.issuer_id or g.issuer_id is distinct from c.earner_user_id then
    return jsonb_build_object('status', 'binding_mismatch');
  end if;
  if p_hashed_inputs->'dod' is distinct from coalesce(c.dod, '[]'::jsonb) then
    return jsonb_build_object('status', 'context_changed');
  end if;
  if c.state in ('DRAFTING', 'AWAITING_ACCEPTANCE') then
    -- A draft has no accepted terms: explicit null agreement evidence.
    if p_hashed_inputs->'agreement' <> 'null'::jsonb or p_event->'agreement_hash' <> 'null'::jsonb then
      return jsonb_build_object('status', 'context_changed');
    end if;
  else
    select e.payload->'_agreement'->>'snapshot_version' into v_accepted_version
      from public.events e
     where e.contract_id = c.id::text and e.type = 'dod.consent_recorded'
     order by e.created_at desc, e.id desc limit 1;
    -- Version 1 is the only snapshot this build can compare.
    if v_accepted_version is distinct from '1' then
      return jsonb_build_object('status', 'agreement_unavailable');
    end if;
    if p_event->'agreement_hash' = 'null'::jsonb
       or p_hashed_inputs->'agreement' is distinct from jsonb_build_object(
         'snapshot_version', 1,
         'project_name', c.project_name,
         'dod', coalesce(c.dod, '[]'::jsonb),
         'amount', coalesce(c.amount_minor, c.amount_jpy),
         'currency', c.currency,
         'deadline', c.deadline,
         'performed_by', coalesce(c.performed_by, 'creator'),
         'offered_by', c.earner_display_name) then
      return jsonb_build_object('status', 'context_changed');
    end if;
  end if;
  if encode(pg_catalog.sha256(pg_catalog.convert_to(private.v5_outer_canonical(
       v_id, v_type, c.id, g.issuer_id, p_event->>'dod_hash', v_created_at, v_prev,
       p_event->>'payload_hash', p_event->>'agreement_hash', p_credential_id, g.issuer_kind), 'UTF8')), 'hex')
     is distinct from p_event->>'event_hash' then
    return jsonb_build_object('status', 'binding_mismatch');
  end if;

  insert into private.v5_write_tickets (txid, event_id) values (pg_catalog.txid_current(), v_id);
  insert into public.events (id, type, contract_id, actor_id, payload, dod_hash, created_at, event_hash,
      tsa_token, prev_event_hash, hash_version, idempotency_key, server_recorded_at, payload_hash,
      agreement_hash, credential_id, issuer_kind)
  values (v_id, v_type, c.id::text, g.issuer_id::text, p_event->'payload', p_event->>'dod_hash', v_created_at,
      p_event->>'event_hash', null, v_prev, 5, v_key, now(), p_event->>'payload_hash',
      p_event->>'agreement_hash', p_credential_id, g.issuer_kind)
  returning * into v_row;

  -- The stored row is the proposal, field by field. A trigger, default or cast
  -- that changed anything rolls the whole transaction back.
  if v_row.id is distinct from v_id or v_row.type is distinct from v_type
     or v_row.contract_id is distinct from c.id::text or v_row.actor_id is distinct from g.issuer_id::text
     or v_row.payload is distinct from p_event->'payload' or v_row.dod_hash is distinct from p_event->>'dod_hash'
     or v_row.created_at is distinct from v_created_at or v_row.event_hash is distinct from p_event->>'event_hash'
     or v_row.tsa_token is not null or v_row.prev_event_hash is distinct from v_prev
     or v_row.hash_version is distinct from 5 or v_row.idempotency_key is distinct from v_key
     or v_row.payload_hash is distinct from p_event->>'payload_hash'
     or v_row.agreement_hash is distinct from p_event->>'agreement_hash'
     or v_row.credential_id is distinct from p_credential_id or v_row.issuer_kind is distinct from g.issuer_kind then
    raise exception 'delegated event % was stored differently from its proposal', v_id using errcode = 'TF010';
  end if;
  return jsonb_build_object('status', 'appended', 'event', to_jsonb(v_row));
end $$;

-- A keyed retry, answered under the lock and after the grant, before anything
-- that only matters for building a new event. Replay never reads the gate: an
-- authorized same-grant retry gets its evidence back even while v5 is closed.
create function public.replay_delegated_event(
  p_contract_id uuid, p_credential_id uuid, p_secret_hash text, p_type text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g record;
  v_existing public.events%rowtype;
begin
  perform public.require_read_committed('replay_delegated_event');
  perform 1 from public.contracts k where k.id = p_contract_id for update;
  if not found then
    return jsonb_build_object('status', 'grant_unknown');
  end if;
  select * into g from private.resolve_entry_agent_grant(p_contract_id, p_credential_id, p_secret_hash, p_type, false);
  if g.status <> 'ok' then
    return jsonb_build_object('status', g.status);
  end if;
  if p_idempotency_key is null then
    return jsonb_build_object('status', 'none');
  end if;
  select * into v_existing from public.events e
   where e.contract_id = p_contract_id::text and e.idempotency_key = p_idempotency_key;
  if not found then
    return jsonb_build_object('status', 'none');
  end if;
  if v_existing.type = p_type and v_existing.actor_id = g.issuer_id::text
     and v_existing.credential_id is not distinct from p_credential_id then
    return jsonb_build_object('status', 'replayed', 'event', to_jsonb(v_existing));
  end if;
  return jsonb_build_object('status', 'idempotency_key_in_use');
end $$;

revoke all on function public.append_delegated_event(uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.replay_delegated_event(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.append_delegated_event(uuid, uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.replay_delegated_event(uuid, uuid, text, text, text) to service_role;

-- Apply-time self-test. TF931..TF934; a failure rolls the migration back.
do $$
declare
  r text;
  f text;
begin
  -- 1. The two RPCs: service_role only, definer, empty search_path.
  foreach f in array array['public.append_delegated_event(uuid,uuid,text,text,jsonb,jsonb)',
                           'public.replay_delegated_event(uuid,uuid,text,text,text)'] loop
    foreach r in array array['anon', 'authenticated', 'public'] loop
      if has_function_privilege(r, f, 'EXECUTE') then
        raise exception 'SELF-TEST FAILED: % may execute %', r, f using errcode = 'TF931';
      end if;
    end loop;
    if not has_function_privilege('service_role', f, 'EXECUTE')
       or (select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = f::regprocedure)
          is distinct from true then
      raise exception 'SELF-TEST FAILED: % is not a service_role definer with empty search_path', f using errcode = 'TF931';
    end if;
  end loop;
  -- 2. Private helpers and trigger functions: no client role or service_role.
  foreach f in array array['private.v5_created_at_ok(timestamptz,timestamptz,timestamptz)',
                           'private.v5_grant_authentication()', 'private.v5_reserved_fields_status(jsonb,text,text)',
                           'private.v5_outer_canonical(uuid,text,uuid,uuid,text,timestamptz,text,text,text,uuid,text)',
                           'private.v5_write_ticket_check()', 'private.v5_write_ticket_confirm()'] loop
    foreach r in array array['anon', 'authenticated', 'service_role', 'public'] loop
      if has_function_privilege(r, f, 'EXECUTE') then
        raise exception 'SELF-TEST FAILED: % may execute %', r, f using errcode = 'TF932';
      end if;
    end loop;
  end loop;
  foreach f in array array['private.v5_write_ticket_check()', 'private.v5_write_ticket_confirm()'] loop
    if (select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = f::regprocedure)
       is distinct from true then
      raise exception 'SELF-TEST FAILED: % is not a definer with empty search_path', f using errcode = 'TF932';
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role', 'public'] loop
    if has_table_privilege(r, 'private.v5_write_tickets', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'SELF-TEST FAILED: % holds a privilege on the write tickets', r using errcode = 'TF932';
    end if;
  end loop;
  -- 3. Both triggers present and enabled; the BEFORE one sorts last.
  if (select count(*) from pg_trigger where tgrelid = 'public.events'::regclass and tgenabled = 'O'
        and tgname in ('zz_v5_write_ticket_check', 'v5_write_ticket_confirm')) <> 2
     or (select max(tgname::text collate "C") from pg_trigger t
          where t.tgrelid = 'public.events'::regclass and not t.tgisinternal
            and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4) is distinct from 'zz_v5_write_ticket_check' then
    raise exception 'SELF-TEST FAILED: the v5 ticket triggers are missing, disabled or misordered' using errcode = 'TF933';
  end if;
  -- 4. Still closed: the CHECK is present and the gate is shut.
  if not exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass
                  and conname = 'events_v5_writes_disabled')
     or (select open from private.v5_write_gate) is distinct from false then
    raise exception 'SELF-TEST FAILED: v5 writes are not still closed' using errcode = 'TF934';
  end if;
end
$$;
