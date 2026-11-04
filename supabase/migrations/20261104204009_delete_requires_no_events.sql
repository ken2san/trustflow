-- Make "deletable" mean "has no evidence", by construction rather than by luck.
--
-- WHAT WAS WRONG WITH THE OLD PREDICATE
-- 20260929000200 allowed a delete on state = 'AWAITING_ACCEPTANCE' with
-- invite_token_used_at null, and its comment justified that as equivalent to
-- "zero rows in events": the acceptance event is the first row ever written,
-- and accept_invitation() writes it in the same transaction that sets
-- invite_token_used_at. That equivalence holds for the paths the client
-- happens to call, and nothing enforces it:
--
--   * log-event has no acceptance check. The earner's JWT matched against
--     earner_user_id is the whole party test, and contract.initiated,
--     contract.cancelled, contract.completed, dispute.opened and
--     rating.submitted carry no role requirement at all. An owner can append
--     to a contract that stays at AWAITING_ACCEPTANCE.
--   * derive_contract_state() returns the current state unchanged unless it is
--     already TERMS_ACCEPTED or later, so such an append does not move the
--     contract out of the deletable set.
--
-- So an event-bearing deletable contract is reachable today. It is not reached
-- only because no code in src/ does it.
--
-- WHY IT MATTERS MORE THAN A TIDINESS ARGUMENT
-- events.contract_id is text with no foreign key (20260313000000, deliberate:
-- pre-migration demo ids), and delete on events is revoked from anon and
-- authenticated (20260924000002). Deleting a contract that has events
-- therefore leaves permanent, undeletable, hash-chained rows pointing at a
-- contract id that no longer exists — in a product whose entire claim is an
-- append-only evidence log. The withdraw-before-acceptance feature, if it is
-- ever built, writes exactly such an event; this predicate is what stops that
-- feature from silently orphaning its own evidence.
--
-- EFFECT ON WHAT IS DELETABLE: none today. Every contract the old predicate
-- admitted has zero events, so the new condition is already true of all of
-- them. This is a guard against a future writer, not a change in behaviour.
--
-- The subquery casts contracts.id to text because that is the type events
-- stores it as; a join without the cast would error rather than match.

drop policy if exists "owner_delete_unaccepted_draft" on contracts;
create policy "owner_delete_unaccepted_draft" on contracts
  for delete
  to authenticated
  using (
    auth.uid() = earner_user_id
    and state = 'AWAITING_ACCEPTANCE'
    and invite_token_used_at is null
    and not exists (
      select 1 from public.events where events.contract_id = contracts.id::text
    )
  );
