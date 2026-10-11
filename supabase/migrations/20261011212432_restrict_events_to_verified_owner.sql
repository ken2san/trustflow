-- A guest's self-declared hirer_email is not proof of authority to read
-- immutable evidence. Only the verified contract creator can read events
-- directly via RLS; guests use the separate guest-contract-events endpoint
-- with their bearer capability. No change to writes or event history.
drop policy if exists "party_read_contract_events" on public.events;
create policy "party_read_contract_events"
  on public.events
  for select to authenticated
  using (
    exists (
      select 1 from public.contracts c
      where c.id::text = events.contract_id
        and c.earner_user_id = (select auth.uid())
    )
  );
