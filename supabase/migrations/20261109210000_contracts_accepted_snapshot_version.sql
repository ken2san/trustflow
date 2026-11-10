-- Record, on the contract row, which agreement-snapshot version its acceptance
-- bound.
--
-- NOT APPLIED ANYWHERE YET. Written and reviewed ahead of time; applying it
-- waits for Kenji's go-ahead at deploy time. Kenji's decision, 2026-11-09.
--
-- WHY THIS COLUMN EXISTS
-- A later act on an accepted agreement must refer to the terms in the shape
-- they were accepted in, not whatever shape is current. That version lives in
-- the acceptance event's payload (`_agreement.snapshot_version`), so today
-- `log-event` and `reissue-guest-access` read the acceptance event to find it —
-- one extra indexed SELECT on every write, and a value that has to be re-read
-- per retry because a draft can be accepted mid-write.
--
-- Having it on the row the writer already fetches removes both: no extra read,
-- and no interleaving to revalidate, because the version arrives in the same
-- snapshot of the row as the state it belongs to.
--
-- WHAT THIS IS NOT
--   * NOT a rehash. No event is rewritten, no stored hash recomputed, no
--     agreement_hash touched. The column is a copy of something the acceptance
--     event already says, kept where the writer can see it.
--   * NOT a new agreed term. It is not in the agreement snapshot, so it is not
--     hashed into any event and changes no digest. It describes the record's
--     format, not the deal.
--   * NOT a backfill of anything unobserved. The value is read out of the
--     acceptance event that already exists; where no acceptance exists, the
--     column stays NULL, which is the honest answer.

alter table contracts
  add column if not exists accepted_snapshot_version integer;

comment on column contracts.accepted_snapshot_version is
  'The agreement-snapshot version this contract''s acceptance bound, copied '
  'from the acceptance event''s payload. NULL means no acceptance has been '
  'recorded, or its version could not be read. Not part of the agreement and '
  'not hashed into any event.';

-- Derived from evidence that already exists, not invented.
--
-- One row per accepted contract, taking the version from its EARLIEST
-- acceptance event — earliest because `validate-invite-token` writes exactly
-- one and `log-event` refuses the type, so a second would itself be a finding,
-- and picking the first is the same rule every reader already uses.
--
-- Contracts with no acceptance event are left NULL. That includes drafts, which
-- is correct, and would include an accepted contract whose acceptance event is
-- missing — which the functions treat as a refusal rather than a default, and
-- which this migration must not paper over by guessing 1.
update contracts c
   set accepted_snapshot_version = (
         select (e.payload -> '_agreement' ->> 'snapshot_version')::integer
           from events e
          where e.contract_id = c.id
            and e.type = 'dod.consent_recorded'
            and (e.payload -> '_agreement' ->> 'snapshot_version') ~ '^[0-9]+$'
          order by e.created_at asc, e.id asc
          limit 1
       )
 where c.accepted_snapshot_version is null;

-- The column is server-owned. A client that could set it could tell a later act
-- to refer to terms in a shape nobody accepted, which is the whole thing the
-- version guard exists to prevent. The same reasoning as every other column in
-- 20260923000000_contracts_server_owned_columns.sql: the client INSERT grant is
-- enumerated, so a column absent from it cannot be written — this adds no grant
-- and therefore stays unwritable by anon and authenticated.
--
-- Deliberately no UPDATE trigger and no NOT NULL: a NULL is meaningful here,
-- and an acceptance is written once.
revoke insert, update on column contracts.accepted_snapshot_version from anon, authenticated;
