-- Let the owner delete a contract that has never been accepted.
--
-- WHY THIS IS SAFE, EVIDENTIALLY
-- The acceptance event (dod.consent_recorded) is the first row ever written
-- for a contract — accept_invitation() appends it in the same transaction
-- that consumes the invite. A contract sitting at its default state,
-- AWAITING_ACCEPTANCE, with invite_token_used_at still null, therefore has
-- ZERO rows in `events`. There is nothing to preserve: deleting it removes a
-- row that was never evidence of anything, not a record of a real
-- transaction. This is not the withdraw-before-acceptance feature (still
-- undecided, see Decisions.md) — that projects an event into contract state
-- for an invite someone may already be looking at. This is narrower: the
-- creator deleting their own never-sent-or-never-opened draft, which is pure
-- clutter with no reader on the other end.
--
-- WHY IT WAS MISSING
-- "Send Invite" persists the contract row immediately, before the link is
-- copied or sent anywhere, because the row is what the invite_token lives on
-- — there is no way to show a working link without it existing first. A user
-- who closes the dialog without copying (or fills out a test contract, as
-- happened here 2026-09-27: three identical drafts with no way to remove
-- them) has no way to remove the leftover row. `delete` was revoked from
-- `contracts` outright in 20260923000000, for every row indiscriminately.
--
-- THE GUARD IS IN THE POLICY, NOT THE CLIENT
-- A client only ever calls this for its own never-opened drafts, but the
-- policy is what actually stops anything else — an accepted contract, or one
-- belonging to someone else — regardless of what the client sends.

grant delete on contracts to authenticated;

drop policy if exists "owner_delete_unaccepted_draft" on contracts;
create policy "owner_delete_unaccepted_draft" on contracts
  for delete
  to authenticated
  using (
    auth.uid() = earner_user_id
    and state = 'AWAITING_ACCEPTANCE'
    and invite_token_used_at is null
  );
