-- The server projects an order it never enforced.
--
-- WHAT WAS MEASURED, 2026-11-06, against E2E with a real guest credential:
--
--   after acceptance        : TERMS_ACCEPTED
--   performance.accepted    : HTTP 201
--   state now               : PERFORMANCE_ACCEPTED   <- terminal, and the
--                                                       record holds no
--                                                       performance.asserted
--
-- A receiver could record accepting a performance nobody ever claimed, and the
-- agreement reached its terminal state. `log-event` checks who the caller is
-- and whether their role may write the type; it never reads `contracts.state`.
-- The UI does not offer the button, which is not access control — the API is
-- the product's surface. Append-only, so such a history cannot be taken back.
--
-- WHY A TRIGGER AND NOT A CHECK IN THE FUNCTION
-- An Edge-side check reads the state, then inserts: the same read-to-write
-- window that `accept_invitation` already closes with `row_version`. The
-- check has to share a transaction with the insert to avoid recreating it.
-- (A dedicated RPC owning lock, authorization, idempotency and insert would
-- serve equally and is the better shape if this grows; a trigger is the
-- smaller diff for one ordering rule. Codex's note, 2026-11-06.)
--
-- AND WHY THE LOCK. Being in one transaction is NOT enough, which was this
-- design's first mistake: two concurrent inserts can both read the same old
-- state and both pass. The contract row is locked, which also serialises
-- against the AFTER INSERT projection that updates the same row.
--
-- SCOPE, WHICH IS THE PART MOST EASILY GOT WRONG
-- Only the three `performance.*` types. Everything else is deliberately
-- untouched:
--
--   * `accept_invitation` sets TERMS_ACCEPTED and *then* inserts the consent
--     event; a blanket state rule would refuse the acceptance that created the
--     state it is checked against.
--   * re-issue replaces the token and then inserts `access.reissued`.
--   * `payment.reported` / `acknowledged` / `disputed` must stay writable
--     AFTER the terminal state — money moves outside TrustFlow, so a payment
--     reported once the work is accepted is the ordinary case, not an error.
--     No ordering is imposed among them either: a one-sided statement is a
--     thing this product records, and refusing one would re-create, as a
--     server error, the "one assertion reads as a verdict" defect fixed the
--     same day.
--
-- Terminal here means the end of the PERFORMANCE flow, not the end of the
-- agreement's life.
--
-- EXISTING ROWS ARE LEFT ALONE. Nothing is repaired, deleted or re-projected.
-- A contract already in PERFORMANCE_ACCEPTED through the hole will simply
-- refuse further performance events; its payment and access paths still work,
-- and its history stays as it was written. This migration does not decide that
-- the work was really received.

begin;

create or replace function public.enforce_performance_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_state text;
begin
  -- Only the performance flow. See the scope note above.
  if new.type not in ('performance.asserted', 'performance.accepted', 'performance.rejected') then
    return new;
  end if;

  -- The lock is the point. Without it two inserts read the same state and
  -- both pass; with it they serialise against each other and against the
  -- projection trigger, which updates this same row.
  select c.state into current_state
  from public.contracts c
  where c.id::text = new.contract_id
  for update;

  -- No contract: leave it to whatever else governs that. This trigger has one
  -- job and inventing a second failure mode here would obscure it.
  if current_state is null then
    return new;
  end if;

  if not (
    (current_state = 'TERMS_ACCEPTED'        and new.type = 'performance.asserted')
    or (current_state = 'AWAITING_CONFIRMATION' and new.type in ('performance.accepted', 'performance.rejected'))
  ) then
    -- A distinct SQLSTATE so the Edge function can answer 409 rather than
    -- 500, and so this can never be mistaken for the 23505 that means a
    -- concurrent event claimed the chain tip — that one is retried, and
    -- retrying a wrong-state refusal would spin forever.
    raise exception
      'event % is not permitted while the agreement is in state %', new.type, current_state
      using errcode = 'TF001',
            hint = 'performance.asserted follows TERMS_ACCEPTED; accepted and rejected follow AWAITING_CONFIRMATION';
  end if;

  return new;
end;
$$;

comment on function public.enforce_performance_order() is
  'Refuses a performance event that does not follow the order derive_contract_state projects. Locks the contract row, so it serialises with the projection and with concurrent inserts.';

drop trigger if exists events_enforce_performance_order on public.events;
create trigger events_enforce_performance_order
  before insert on public.events
  for each row
  execute function public.enforce_performance_order();

commit;
