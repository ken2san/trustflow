-- Let the owner issue a counterparty a fresh access credential.
--
-- WHY THIS EXISTS
-- A guest Hirer's guest_access_token lives in exactly one place: the
-- localStorage of the browser they accepted in (src/lib/guestSession.js). The
-- invite token is single-use and already consumed, send-acceptance-email is
-- deleted, and no URL reopens the guest view. So a counterparty who clears
-- their browser, switches device, or accepted in a private window is locked
-- out for good — they cannot confirm delivery or report payment, and the
-- owner's side waits on a review that can never come. Found in the 2026-10-10
-- dogfood, on a contract whose chain was perfectly intact; what was lost was a
-- cache, not evidence.
--
-- WHY NOT RECOGNISE THE HIRER BY EMAIL
-- The obvious repair — let a signed-in account whose email matches
-- contracts.hirer_email act as the guest — was proposed and rejected. That
-- address is typed by the guest at acceptance and recorded as unverified
-- (_claimed_identity_verified: false). Granting write access to whoever
-- controls that mailbox moves authorisation from a secret the OWNER delivered
-- to a string the COUNTERPARTY chose, and admits writers who never held the
-- invite: a mistyped address, a shared info@ mailbox, a recycled address, or
-- anyone the guest named. party_read_contract_events already matches on that
-- email, but reading history and signing a new assertion into the record are
-- different privileges, so it is not a precedent.
--
-- Reissue keeps the property that made the original credential meaningful:
-- authority flows from the owner, through whatever out-of-band channel they
-- used for the invite. It adds no new principal — an owner can already mint
-- guest access by accepting their own invite — and it gives the system its
-- first way to kill a leaked token, since the new value overwrites the old.
--
-- WHY IT IS ONE TRANSACTION
-- Rotating the credential and recording that it was rotated must land
-- together. Updating alone leaves the credential silently changed, so a reader
-- cannot tell that later guest events may be a different person; inserting
-- alone leaves a record of something that did not happen. Both are failures of
-- the same guarantee this product sells, and accept_invitation already solved
-- the identical problem the same way.

create or replace function public.reissue_guest_access(
  p_contract_id         uuid,
  p_earner_user_id      uuid,
  p_guest_token         text,
  p_guest_token_expires timestamptz,
  p_prev_event_hash     text,
  p_event               jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c       record;
  v_tip   text;
  v_event public.events;
begin
  -- for update: the row is re-read and held, so a concurrent reissue or
  -- acceptance cannot interleave between the checks below and the write.
  select * into c
    from public.contracts
   where id = p_contract_id
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Only the owner, and only the real one. The caller passes a uid it has
  -- already verified against a JWT, but the comparison belongs here too: this
  -- function runs as its definer, so it must not depend on the caller having
  -- been careful.
  if c.earner_user_id is distinct from p_earner_user_id then
    return jsonb_build_object('status', 'not_owner');
  end if;

  -- Nothing to reissue before anyone has accepted. The invite token is still
  -- live in that state and is the right thing to re-share; minting a guest
  -- credential for a counterparty who does not exist yet would create a way in
  -- that bypasses acceptance entirely.
  if c.invite_token_used_at is null or c.hirer_email is null then
    return jsonb_build_object('status', 'not_accepted');
  end if;

  select e.event_hash into v_tip
    from public.events e
   where e.contract_id = c.id::text
     and e.event_hash is not null
   -- The ordering every writer and verifier uses. Two events can share a
   -- millisecond, and a tip that depends on the planner is a tip two writers
   -- can disagree about.
   order by e.created_at desc, e.id desc
   limit 1;

  -- Same domain on both sides, for the reason spelled out in
  -- 20260928000000: an empty chain is NULL here and the literal 'GENESIS' in
  -- the caller. A reissue can never be the first event on a contract — an
  -- acceptance always precedes it — but the coalesce costs nothing and means
  -- this function does not depend on which convention the caller uses.
  if coalesce(v_tip, 'GENESIS') is distinct from coalesce(p_prev_event_hash, 'GENESIS') then
    return jsonb_build_object('status', 'chain_conflict');
  end if;

  -- ── Commit point. Both writes land, or neither does. ──
  --
  -- Only the credential columns change. freeze_accepted_terms raises if any
  -- agreed term moves after acceptance, and deliberately does not look at
  -- these: rotating who can act is not changing what was agreed.
  update public.contracts
     set guest_access_token            = p_guest_token::uuid,
         guest_access_token_expires_at = p_guest_token_expires
   where id = c.id;

  -- jsonb_populate_record rather than a hand-written column list, so this
  -- function carries no second copy of the events schema that could drift
  -- from the table. See 20260929000100 for why the uuid cast above is
  -- explicit while this is not.
  insert into public.events
  select *
    from jsonb_populate_record(
      null::public.events,
      p_event || jsonb_build_object('server_recorded_at', now())
    )
  returning * into v_event;

  return jsonb_build_object(
    'status', 'reissued',
    'event',  to_jsonb(v_event)
  );
end;
$$;

-- Callable only by the service role, through the reissue-guest-access Edge
-- Function. It is SECURITY DEFINER and takes the owner's uid as a parameter,
-- so a client that could call it directly could pass any uid it liked.
revoke execute on function public.reissue_guest_access(uuid, uuid, text, timestamptz, text, jsonb)
  from public, anon, authenticated;
