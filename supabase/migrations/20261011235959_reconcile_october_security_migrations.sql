-- History reconciliation only. No schema change.
--
-- The same drift as 20260924123733, 20260924132813 and 20260927235959, for the
-- same reason a third time: the three migrations below were applied through the
-- Supabase management API rather than `supabase db push`. The API stamps its own
-- timestamp version per call, so each database recorded a different version for
-- the same change:
--
--   local file                                      E2E             production
--   20261011212432 restrict_events_to_verified_owner  20261011212844  20261011212939
--   20261011215504 enforce_agreement_wellformedness   20261011215613  20261011215651
--   20261011222132 validate_contract_creation_only    20261011224039  20261011224110
--
-- schema_migrations stores no checksum, so the CLI matches on version alone and
-- would have replayed all three on the next push.
--
-- WHY REPLAY WAS NOT AN ACCEPTABLE OUTCOME
-- Each file drops a constraint or policy before recreating it. Replay is
-- harmless only if it runs to completion: a push that failed between the `drop
-- constraint if exists` and the `add constraint` would leave the agreement
-- well-formedness checks off, and contract creation would silently stop being
-- validated. The statements are individually safe; the window between them is
-- not.
--
-- THE CORRESPONDENCE WAS VERIFIED, NOT ASSUMED
-- Each recorded statement list was read back from schema_migrations and
-- compared with its local file after stripping comments and all whitespace.
-- Production and E2E hold identical digests for all three. Two match their
-- local file exactly:
--
--   restrict_events_to_verified_owner  51a270ba8779af4f35c964e424c765b1
--   validate_contract_creation_only    e450fc61a0d3de7a4024e0b591f78988
--
-- enforce_agreement_wellformedness differs from its file by exactly 85
-- characters, and the difference is entirely the API's own rewriting: it
-- schema-qualifies `contracts` to `public.contracts` in all fourteen places
-- (+98) and drops the file's explicit `begin;` / `commit;` (-13), because it
-- wraps the body in a transaction itself. The statement list is otherwise
-- character-for-character the same, and the eight CHECK constraints, the
-- events read policy and the creation trigger were each confirmed present in
-- both databases.
--
-- WHY THIS FILE DOES NOT RECORD ITSELF
-- Its predecessors did not need a self-insert: their version numbers were
-- chosen to match what the API had already stamped. That trick cannot work
-- here, because the two databases stamped different versions for every one of
-- these three changes, so no single filename can match both. The obvious
-- alternative — having this file insert its own version — is the one thing it
-- must not do. 20260924132813 already demonstrated the result: db push records
-- a migration AFTER running it, with a plain insert, so a body that has already
-- written its own row makes push fail with `duplicate key ... 
-- schema_migrations_pkey` and leave history claiming work that never ran. This
-- file's own row is therefore written by whoever applies it — by db push
-- automatically, or by hand in the same statement when it is applied through
-- the API.
--
-- 20261011000000_reissue_guest_access is deliberately NOT listed. E2E has it;
-- production does not, and the function it creates is genuinely absent there.
-- That is a real gap, not drift, and it must keep showing as pending until it
-- is applied on purpose.

insert into supabase_migrations.schema_migrations (version, name)
values
  ('20261011212432', 'restrict_events_to_verified_owner'),
  ('20261011215504', 'enforce_agreement_wellformedness'),
  ('20261011222132', 'validate_contract_creation_only')
on conflict (version) do nothing;

-- Both databases' generated rows. Each delete matches at most one database and
-- is inert in the other, and all six are inert on a fresh project.
delete from supabase_migrations.schema_migrations
where version in ('20261011212844', '20261011215613', '20261011224039',
                  '20261011212939', '20261011215651', '20261011224110');
