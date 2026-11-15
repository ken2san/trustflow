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
-- look again. This function is that look.
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
-- REPLAY IS AUTHORISED FIRST
-- An idempotency hit returns the earlier event only after the credential has
-- passed under the lock. A guest whose token was replaced cannot use a retry
-- to read back what the old token wrote — the refusal comes before the lookup.
-- The match rule is the one `idempotencyOutcome` states in
-- _shared/eventWriteRules.ts: same type AND same actor, or it is a collision.
--
-- WHY IT IS SAFE TO DEPLOY IN EITHER ORDER, AND WHY ONE ORDER IS REQUIRED
-- This migration only adds a function. No table, trigger or existing function
-- changes, so the deployed `log-event` keeps writing exactly as before against
-- a database that has it (old function + new DB: compatible, old race kept
-- until the function is redeployed). A `log-event` that calls this function
-- against a database without it gets PostgREST's PGRST202 and refuses the
-- guest write as `guest_append_unavailable` — fail-closed, owner writes
-- unaffected (new function + old DB: guest writes refused, nothing wrong is
-- written). There is deliberately no fallback to the old two-round-trip path:
-- a fallback would keep the race alive in exactly the deployment it exists
-- for, permanently and silently. So: apply this migration before deploying
-- the `log-event` that uses it.
--
-- Historical events are untouched and the event is built by the caller exactly
-- as before (_shared/eventRecord.ts), so the hash input does not change. The
-- presented token is compared and then dropped: it is not a column of
-- `events`, and nothing here writes or raises it.

begin;

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
  c          record;
  v_now      timestamptz;
  v_key      text := p_event->>'idempotency_key';
  v_existing public.events;
  v_tip      text;
  v_event    public.events;
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

  -- Text comparison, exact, as guestCredentialStillValid does it: the stored
  -- value is a server-minted uuid and its canonical text form is what was
  -- handed out. No cast of the presented value, so a malformed one is a
  -- refusal rather than an exception carrying it in the message.
  --
  -- Not fixed-work, unlike the Edge-side compare. Only a request whose token
  -- already matched at the top of `log-event` reaches this call, so the
  -- comparison only ever sees a value that was correct a moment ago.
  if p_guest_token is null
     or c.guest_access_token is null
     or c.guest_access_token::text is distinct from p_guest_token then
    return jsonb_build_object('status', 'guest_credential_revoked');
  end if;

  v_now := clock_timestamp();
  if c.guest_access_token_expires_at is null
     or c.guest_access_token_expires_at < v_now then
    return jsonb_build_object('status', 'guest_credential_expired');
  end if;

  -- The event must be for this contract and name the guest this contract
  -- recorded at acceptance. The caller derives both from the same row, but
  -- this function runs as its definer and must not depend on the caller
  -- having been careful — the same reason reissue_guest_access re-checks the
  -- owner.
  if p_event->>'contract_id' is distinct from c.id::text
     or c.hirer_email is null
     or p_event->>'actor_id' is distinct from 'guest:' || c.hirer_email then
    return jsonb_build_object('status', 'not_a_party');
  end if;

  if v_key is not null then
    select * into v_existing
      from public.events e
     where e.contract_id = c.id::text
       and e.idempotency_key = v_key;
    if found then
      if v_existing.type = p_event->>'type'
         and v_existing.actor_id = p_event->>'actor_id' then
        return jsonb_build_object(
          'status', 'replayed',
          'event',  to_jsonb(v_existing)
        );
      end if;
      return jsonb_build_object('status', 'idempotency_key_in_use');
    end if;
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

-- Service role only, through log-event. It is SECURITY DEFINER and decides
-- authority from a token passed as a parameter; a client able to call it
-- directly would be a second door around the Edge Function's checks.
revoke execute on function public.append_guest_event(uuid, text, text, jsonb)
  from public, anon, authenticated;

commit;
