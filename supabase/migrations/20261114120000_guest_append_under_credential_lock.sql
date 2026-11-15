-- Append a guest's event in the same transaction that re-checks their credential.
--
-- WHAT THIS CLOSES
-- `log-event` tested a guest's guest_access_token against a contract row it
-- had read, and then inserted the event in a separate round trip. Between the
-- two, `reissue_guest_access` could rotate the credential and commit, and the
-- insert still landed: a token the owner had already replaced wrote evidence.
-- Re-reading the row one round trip before the insert (Task 17) narrowed that
-- window and could not close it, because the event row does not carry the
-- token that was presented, so nothing inside the insert's transaction could
-- look again. append_guest_event is that look.
--
-- THE SERIALIZATION BOUNDARY, stated at the size it holds:
--   * After a reissue commits, the old token cannot create an event. Either
--     this function takes the contract lock after the reissue released it and
--     sees the new token, or the reissue waits for this function's commit.
--   * A guest append that took the lock first commits first, and the reissue
--     that was waiting then finds a new chain tip and is retried by its Edge
--     Function. That event is legitimately ordered BEFORE `access.reissued` in
--     the record: it was authorised by the credential live at that moment.
--   * Reads are not covered. A response already delivered, or a read already
--     past its own credential check, cannot be recalled by anything here.
--
-- LOCK ORDERING
-- One lock: the `contracts` row, `for update`, taken first, before any read of
-- `events`. That is the lock and the order every other writer of evidence for
-- a contract already uses — reissue_guest_access and accept_invitation lock it
-- before their insert, the `events` insert triggers (20261108121000,
-- 20261108121500, 20261106210207) lock it again for the row they guard, and
-- refuse_delete_of_contract_with_evidence locks it on delete. The insert below
-- re-acquires a lock this transaction already holds, which never waits. No
-- writer takes a second contract's lock, so there is no cycle to deadlock on.
--
-- WHICH CLOCK DECIDES EXPIRY
-- The database's, `clock_timestamp()`, read AFTER the lock is held. Not
-- `now()`: that is the transaction's start time, and a call that waited on the
-- lock behind a reissue would test expiry against a moment before it waited.
-- Not the Edge isolate's clock either; that one still decides the early refusal
-- at the top of `log-event`, which stays as a cheap first gate, but the answer
-- that binds is this one. The two can disagree by a skew for a token at the
-- edge of its lifetime; the database is the one place both reissue and append
-- read the same clock.
--
--
-- REPLAY IS AUTHORISED FIRST, AND ANSWERED BEFORE ANYTHING ELSE CAN REFUSE IT
-- An idempotency hit returns the earlier event only after the credential has
-- passed under the lock. A guest whose token was replaced cannot use a retry
-- to read back what the old token wrote — the refusal comes before the lookup.
-- The match rule is the one `idempotencyOutcome` states in
-- _shared/eventWriteRules.ts: same type AND same actor, or it is a collision.
--
-- Two entry points share that rule, through guest_append_refusal and
-- guest_append_replay below, so there is one copy of each check:
--   * replay_guest_event — lock, authorise, look up the key, and nothing else.
--     `log-event` calls it for a keyed guest request BEFORE it reads the chain
--     tip, the accepted snapshot version or its own clock. Those pre-checks
--     exist to build a NEW event; a retry of a write that already landed must
--     not be refused by them (an isolate whose clock is behind the chain, or a
--     contract whose acceptance has since become unreadable, would otherwise
--     turn a successful earlier write into an error on retry). Codex Task 76,
--     Q1.
--   * append_guest_event — the same lookup again under its own lock, because
--     a twin carrying the same key can commit between the two calls.
--
-- server_recorded_at IS THE TRANSACTION START
-- The insert stamps `now()`, as reissue_guest_access does. That is the start
-- of this transaction, which can be BEFORE the wait on the contract lock — it
-- is when the database began handling the call, not when the row committed.
-- It is not `created_at` (the isolate's stamp, inside the hash) and it is not
-- in the hash at all. Kept as is, and said here so nobody reads it as a
-- post-lock commit time.
--
-- WHY IT IS SAFE TO DEPLOY IN EITHER ORDER, AND WHY ONE ORDER IS REQUIRED
-- This migration only adds functions. No table, trigger or existing function
-- changes, so the deployed `log-event` keeps writing exactly as before against
-- a database that has them (old function + new DB: compatible, old race kept
-- until the function is redeployed). A `log-event` that calls them against a
-- database without them gets PostgREST's PGRST202 and refuses the guest write
-- as `guest_append_unavailable` — fail-closed, owner writes unaffected (new
-- function + old DB: guest writes refused, nothing wrong is written). There is
-- deliberately no fallback to the old two-round-trip path: a fallback would
-- keep the race alive in exactly the deployment it exists for, permanently and
-- silently. So: apply this migration before deploying the `log-event` that
-- uses it.
--
-- Historical events are untouched and the event is built by the caller exactly
-- as before (_shared/eventRecord.ts), so the hash input does not change. The
-- presented token is compared and then dropped: it is not a column of
-- `events`, and nothing here writes or raises it.

begin;

-- Why this guest may not act, or NULL if they may. Called only with `c` read
-- under `for update` by one of the two functions below, so the answer holds
-- until their transaction ends.
create or replace function public.guest_append_refusal(
  c             public.contracts,
  p_guest_token text,
  p_actor_id    text
)
returns text
language plpgsql
set search_path = ''
as $$
begin
  -- Text comparison, exact, as guestCredentialStillValid does it: the stored
  -- value is a server-minted uuid and its canonical text form is what was
  -- handed out. No cast of the presented value, so a malformed one is a
  -- refusal rather than an exception carrying it in the message.
  --
  -- Not fixed-work, unlike the Edge-side compare. On the intended path only a
  -- request whose token already matched at the top of `log-event` reaches
  -- this; a direct service-role caller bypasses that gate, and holds a key
  -- that could read the token outright anyway.
  if p_guest_token is null
     or c.guest_access_token is null
     or c.guest_access_token::text is distinct from p_guest_token then
    return 'guest_credential_revoked';
  end if;

  -- The database clock, now — after the caller's lock — not now(), the
  -- transaction start.
  if c.guest_access_token_expires_at is null
     or c.guest_access_token_expires_at < clock_timestamp() then
    return 'guest_credential_expired';
  end if;

  -- The actor must be the guest this contract recorded at acceptance. The
  -- caller derives it from the same row, but the functions using this run as
  -- their definer and must not depend on the caller having been careful —
  -- the same reason reissue_guest_access re-checks the owner.
  if c.hirer_email is null
     or p_actor_id is distinct from 'guest:' || c.hirer_email then
    return 'not_a_party';
  end if;

  return null;
end;
$$;

-- What an existing row under this key means for this operation, or NULL when
-- there is none. Only ever called after guest_append_refusal returned NULL.
create or replace function public.guest_append_replay(
  c        public.contracts,
  p_key    text,
  p_type   text,
  p_actor_id text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_existing public.events;
begin
  if p_key is null then
    return null;
  end if;
  select * into v_existing
    from public.events e
   where e.contract_id = c.id::text
     and e.idempotency_key = p_key;
  if not found then
    return null;
  end if;
  if v_existing.type = p_type and v_existing.actor_id = p_actor_id then
    return jsonb_build_object('status', 'replayed', 'event', to_jsonb(v_existing));
  end if;
  return jsonb_build_object('status', 'idempotency_key_in_use');
end;
$$;

create or replace function public.replay_guest_event(
  p_contract_id     uuid,
  p_guest_token     text,
  p_type            text,
  p_actor_id        text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c         public.contracts;
  v_refusal text;
begin
  perform public.require_read_committed('replay_guest_event');

  select * into c
    from public.contracts
   where id = p_contract_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_refusal := public.guest_append_refusal(c, p_guest_token, p_actor_id);
  if v_refusal is not null then
    return jsonb_build_object('status', v_refusal);
  end if;

  return coalesce(
    public.guest_append_replay(c, p_idempotency_key, p_type, p_actor_id),
    jsonb_build_object('status', 'none')
  );
end;
$$;

create or replace function public.append_guest_event(
  p_contract_id     uuid,
  p_guest_token     text,
  p_prev_event_hash text,
  p_event           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c         public.contracts;
  v_refusal text;
  v_replay  jsonb;
  v_tip     text;
  v_event   public.events;
begin
  -- The re-read after the lock is only fresh under READ COMMITTED. At a
  -- stronger level the select below could return the token as it stood
  -- before a reissue that committed while this call waited, which is the
  -- exact race this function exists to close. See 20261108134500.
  perform public.require_read_committed('append_guest_event');

  select * into c
    from public.contracts
   where id = p_contract_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_refusal := public.guest_append_refusal(c, p_guest_token, p_event->>'actor_id');
  if v_refusal is not null then
    return jsonb_build_object('status', v_refusal);
  end if;

  if p_event->>'contract_id' is distinct from c.id::text then
    return jsonb_build_object('status', 'not_a_party');
  end if;

  v_replay := public.guest_append_replay(
    c, p_event->>'idempotency_key', p_event->>'type', p_event->>'actor_id');
  if v_replay is not null then
    return v_replay;
  end if;

  select e.event_hash into v_tip
    from public.events e
   where e.contract_id = c.id::text
     and e.event_hash is not null
   order by e.created_at desc, e.id desc
   limit 1;

  -- Same domains as reissue_guest_access: NULL here for an empty chain, the
  -- literal 'GENESIS' in the caller.
  if coalesce(v_tip, 'GENESIS') is distinct from coalesce(p_prev_event_hash, 'GENESIS') then
    return jsonb_build_object('status', 'chain_conflict');
  end if;

  -- The insert triggers still run and still raise TF001/TF002/TF003/TF005;
  -- the caller maps those exactly as it does for a direct insert.
  -- server_recorded_at: the transaction start, see the header.
  insert into public.events
  select *
    from jsonb_populate_record(
      null::public.events,
      p_event || jsonb_build_object('server_recorded_at', now())
    )
  returning * into v_event;

  return jsonb_build_object(
    'status', 'appended',
    'event',  to_jsonb(v_event)
  );
end;
$$;

comment on function public.append_guest_event(uuid, text, text, jsonb) is
  'Appends a guest event in the transaction that re-checks the presented guest_access_token and its expiry under a lock on the contract row, so a reissue that has committed cannot be outlived by a write using the old token.';
comment on function public.replay_guest_event(uuid, text, text, text, text) is
  'Answers a keyed guest retry under the contract lock, after the same credential check as append_guest_event, and before any check that only matters for building a new event.';

-- Service role only, through log-event. The two entry points are SECURITY
-- DEFINER and decide authority from a token passed as a parameter; a client
-- able to call them directly would be a second door around the Edge
-- Function's checks. The helpers carry no authority of their own but are
-- closed too, so the callable surface is exactly what log-event uses.
revoke execute on function public.append_guest_event(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.replay_guest_event(uuid, text, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.guest_append_refusal(public.contracts, text, text)
  from public, anon, authenticated;
revoke execute on function public.guest_append_replay(public.contracts, text, text, text)
  from public, anon, authenticated;

-- ── Self-test, rollback-only and non-concurrent ─────────────────────────────
-- Grants, a revoked token, an expired token, and replay — including that a
-- replaced token cannot replay. It cannot stand in for the two-session race
-- (scripts/race-guest-reissue-vs-append.sh); it proves the single-session
-- rules on every database this is applied to, at apply time. Nothing is
-- committed: the final raise takes the scratch contract and its events back.
do $$
declare
  v_cid    uuid;
  v_t1     text := gen_random_uuid()::text;
  v_t2     text := gen_random_uuid()::text;
  v_actor  text := 'guest:self-test@example.invalid';
  v_role   text;
  v_fn     text;
  v_r      jsonb;
  v_first  text;
  v_count  bigint;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    continue when not exists (select 1 from pg_catalog.pg_roles where rolname = v_role);
    foreach v_fn in array array[
      'public.append_guest_event(uuid,text,text,jsonb)',
      'public.replay_guest_event(uuid,text,text,text,text)'
    ] loop
      if has_function_privilege(v_role, v_fn, 'execute') then
        raise exception 'SELF-TEST FAILED: % can execute %', v_role, v_fn using errcode = 'TF900';
      end if;
    end loop;
  end loop;

  insert into public.contracts (project_name, dod, amount_minor, currency)
  values ('self-test guest append', '["self-test"]'::jsonb, 1, 'JPY')
  returning id into v_cid;
  update public.contracts
     set hirer_email = 'self-test@example.invalid', invite_token_used_at = now(),
         guest_access_token = v_t1::uuid,
         guest_access_token_expires_at = clock_timestamp() + interval '1 day'
   where id = v_cid;

  -- A token that is not the contract's.
  v_r := public.append_guest_event(v_cid, gen_random_uuid()::text, 'GENESIS', jsonb_build_object(
    'id', gen_random_uuid(), 'type', 'rating.submitted', 'contract_id', v_cid::text,
    'actor_id', v_actor, 'payload', '{}'::jsonb, 'created_at', clock_timestamp(),
    'event_hash', 'self-test-x', 'prev_event_hash', 'GENESIS', 'idempotency_key', 'k1'));
  if v_r->>'status' is distinct from 'guest_credential_revoked' then
    raise exception 'SELF-TEST FAILED: wrong token gave %', v_r using errcode = 'TF900';
  end if;

  -- The live token writes; the same operation again replays through both
  -- entry points and writes nothing.
  v_r := public.append_guest_event(v_cid, v_t1, 'GENESIS', jsonb_build_object(
    'id', gen_random_uuid(), 'type', 'rating.submitted', 'contract_id', v_cid::text,
    'actor_id', v_actor, 'payload', '{}'::jsonb, 'created_at', clock_timestamp(),
    'event_hash', 'self-test-a', 'prev_event_hash', 'GENESIS', 'idempotency_key', 'k1'));
  if v_r->>'status' is distinct from 'appended' then
    raise exception 'SELF-TEST FAILED: live token gave %', v_r using errcode = 'TF900';
  end if;
  v_first := v_r->'event'->>'id';

  v_r := public.replay_guest_event(v_cid, v_t1, 'rating.submitted', v_actor, 'k1');
  if v_r->>'status' is distinct from 'replayed' or v_r->'event'->>'id' is distinct from v_first then
    raise exception 'SELF-TEST FAILED: replay_guest_event gave %', v_r using errcode = 'TF900';
  end if;
  v_r := public.append_guest_event(v_cid, v_t1, 'self-test-a', jsonb_build_object(
    'id', gen_random_uuid(), 'type', 'rating.submitted', 'contract_id', v_cid::text,
    'actor_id', v_actor, 'payload', '{}'::jsonb, 'created_at', clock_timestamp(),
    'event_hash', 'self-test-b', 'prev_event_hash', 'self-test-a', 'idempotency_key', 'k1'));
  if v_r->>'status' is distinct from 'replayed' or v_r->'event'->>'id' is distinct from v_first then
    raise exception 'SELF-TEST FAILED: append replay gave %', v_r using errcode = 'TF900';
  end if;
  select count(*) into v_count from public.events where contract_id = v_cid::text;
  if v_count <> 1 then
    raise exception 'SELF-TEST FAILED: replay wrote, % events', v_count using errcode = 'TF900';
  end if;

  -- Same key, different operation: a collision, never the other row.
  v_r := public.replay_guest_event(v_cid, v_t1, 'dispute.opened', v_actor, 'k1');
  if v_r->>'status' is distinct from 'idempotency_key_in_use' then
    raise exception 'SELF-TEST FAILED: collision gave %', v_r using errcode = 'TF900';
  end if;
  v_r := public.replay_guest_event(v_cid, v_t1, 'rating.submitted', v_actor, 'k-unused');
  if v_r->>'status' is distinct from 'none' then
    raise exception 'SELF-TEST FAILED: unused key gave %', v_r using errcode = 'TF900';
  end if;

  -- The token is replaced, as reissue does it: the old one can no longer
  -- replay what it wrote.
  update public.contracts set guest_access_token = v_t2::uuid where id = v_cid;
  v_r := public.replay_guest_event(v_cid, v_t1, 'rating.submitted', v_actor, 'k1');
  if v_r->>'status' is distinct from 'guest_credential_revoked' then
    raise exception 'SELF-TEST FAILED: replaced-token replay gave %', v_r using errcode = 'TF900';
  end if;

  -- Expired: refused for a write and for a replay alike.
  update public.contracts
     set guest_access_token_expires_at = clock_timestamp() - interval '1 second'
   where id = v_cid;
  v_r := public.replay_guest_event(v_cid, v_t2, 'rating.submitted', v_actor, 'k1');
  if v_r->>'status' is distinct from 'guest_credential_expired' then
    raise exception 'SELF-TEST FAILED: expired replay gave %', v_r using errcode = 'TF900';
  end if;
  v_r := public.append_guest_event(v_cid, v_t2, 'self-test-a', jsonb_build_object(
    'id', gen_random_uuid(), 'type', 'rating.submitted', 'contract_id', v_cid::text,
    'actor_id', v_actor, 'payload', '{}'::jsonb, 'created_at', clock_timestamp(),
    'event_hash', 'self-test-c', 'prev_event_hash', 'self-test-a', 'idempotency_key', 'k2'));
  if v_r->>'status' is distinct from 'guest_credential_expired' then
    raise exception 'SELF-TEST FAILED: expired append gave %', v_r using errcode = 'TF900';
  end if;

  raise exception 'self-test complete' using errcode = 'TF901';
exception
  when sqlstate 'TF901' then null;
end $$;

commit;
