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
  'The agreement-snapshot version number this contract''s acceptance recorded, '
  'copied from the acceptance event''s payload. NOT a guarantee that the value '
  'is a version any build supports: a consumer must check it and refuse an '
  'unsupported one, exactly as acceptedSnapshotVersion does. NULL means no '
  'usable version is recorded here and the acceptance event is the only '
  'source. Not part of the agreement and not hashed into any event.';

-- WHAT THIS COLUMN PROMISES, AND WHAT IT DOES NOT.
--
-- Codex's finding 2 on the Task 30 re-review: the backfill keeps any integral
-- JSON number in signed-integer range, including 0 and 2, while the runtime
-- supports only version 1. So "unsupported versions stay NULL" — which my
-- Task 29 report claimed — was too broad. It is documented rather than
-- restricted, and the reason is that the two are different facts:
--
--   NULL          no usable version is recorded HERE. Could be a draft with no
--                 acceptance, or an acceptance whose payload this migration
--                 could not read. A consumer must fall back to the acceptance
--                 event, which is what distinguishes those cases today —
--                 `accepted_version_missing` versus
--                 `accepted_version_unsupported`.
--   a number      the number the acceptance actually recorded. It MAY be a
--                 version no build supports.
--
-- Restricting the column to `= 1` would collapse "the acceptance bound v2" into
-- "nothing is recorded", and those must stay apart: the first is a refusal with
-- a reason, the second is a fallback. A cache of evidence should not be more
-- opinionated than the evidence, and a column that silently drops a value it
-- does not recognise is how a future version becomes invisible.
--
-- THE CONTRACT FOR THE CONSUMER, when the functions are changed to read this:
-- treat a non-NULL value exactly as `acceptedSnapshotVersion` treats the value
-- it reads from the event — check it against the supported set and refuse if it
-- is not there. Treat NULL as "ask the evidence", not as "version 1".

-- Derived from evidence that already exists, not invented.
--
-- THE EXTRACTION IS A FUNCTION, in pg_temp, for two reasons. It is the one
-- definition of the rule, used by the backfill below and asserted by the
-- self-test at the bottom — and the self-test is what makes the ordering
-- testable at all, since the ordering lives in the query rather than in a
-- predicate. And pg_temp means it disappears with this migration's session, so
-- a one-shot helper cannot be left behind in the schema.
--
-- `e.contract_id = c.id::text`, matching every other migration that joins
-- these two. `events.contract_id` is TEXT on purpose and must stay that way
-- (20260313000000_events_table.sql:90) because it holds non-UUID values from
-- the pre-migration demo flow, while `contracts.id` is UUID. PostgreSQL cannot
-- resolve `text = uuid`, so the first version of this migration would have
-- failed at this UPDATE — on an empty table too. Codex's finding 1.
create function pg_temp.accepted_snapshot_version(p_contract_id uuid)
returns integer
language sql
stable
as $fn$
  -- EARLIEST ACCEPTANCE FIRST, then validate it. The other way round — which
  -- is what the first version did — silently promotes a LATER acceptance when
  -- the earliest one has no usable version, while the Edge Function reads the
  -- earliest and refuses. The column would then disagree with the code that is
  -- supposed to replace it. Codex's finding 2.
  --
  -- Same order as `acceptedSnapshotVersion` in _shared/eventRecord.ts:
  -- (created_at asc, id asc). Two events can share a millisecond, and a tie
  -- broken differently in two places is a tie broken wrongly in one of them.
  with earliest as (
    select e.payload -> '_agreement' -> 'snapshot_version' as sv
      from public.events e
     where e.contract_id = p_contract_id::text
       and e.type = 'dod.consent_recorded'
     order by e.created_at asc, e.id asc
     limit 1
  )
  select case
           -- A JSON NUMBER, not a string. `->>` would render the JSON string
           -- "1" as the text `1`, indistinguishable from the number 1 — and
           -- the runtime helper refuses a string, so the column must too.
           when jsonb_typeof(sv) = 'number'
            -- Integral: 1.5 is not a version, and a bare cast would round it
            -- into one.
            and sv::numeric = trunc(sv::numeric)
            -- In range. jsonb stores numbers as `numeric`, so a JSON value of
            -- 99999999999999999999 is perfectly storable and would abort the
            -- whole migration on the cast to integer.
            and sv::numeric between -2147483648 and 2147483647
           then (sv::numeric)::integer
         end
    from earliest;
$fn$;

-- One row per contract, from its earliest acceptance, where that acceptance
-- carries a usable version.
--
-- Everything else stays NULL, which is the honest answer and the one the
-- functions act on: a draft has no acceptance; an accepted contract whose
-- acceptance event is missing or whose version is unreadable is a refusal in
-- `acceptedSnapshotVersion`, and this migration must not paper that over by
-- guessing 1.
update contracts c
   set accepted_snapshot_version = pg_temp.accepted_snapshot_version(c.id)
 where c.accepted_snapshot_version is null
   and pg_temp.accepted_snapshot_version(c.id) is not null;

-- The column is server-owned. A client that could set it could tell a later act
-- to refer to terms in a shape nobody accepted, which is the whole thing the
-- version guard exists to prevent. The same reasoning as every other column in
-- 20260923000000_contracts_server_owned_columns.sql: the client INSERT grant is
-- enumerated, so a column absent from it cannot be written — this adds no grant
-- and therefore stays unwritable by anon and authenticated.
--
-- Deliberately no UPDATE trigger and no NOT NULL: a NULL is meaningful here,
-- and an acceptance is written once.
-- Column-level privileges take parentheses, not `on column` — which the first
-- version of this line got wrong and which only applying the chain revealed.
revoke insert (accepted_snapshot_version), update (accepted_snapshot_version)
    on table contracts from anon, authenticated;

-- Self-test. Same shape as 20261108121500 and 20261108134500: build fixtures,
-- assert, then roll the whole lot back with a sentinel error, because `events`
-- is append-only and a rollback is the only way to take a test row back.
--
-- It asserts the extraction FUNCTION rather than re-running the UPDATE, so the
-- cases below are the rule itself rather than a particular table's contents.
-- The last one is the reason the function exists at all: it tests the ordering,
-- which lives in the query and cannot be reached by a predicate test.
do $$
declare
  v_contract uuid;
  v_at       timestamptz := now();
  v_got      integer;
begin
  -- A contract with no acceptance at all: a draft. NULL, not 1.
  insert into public.contracts (project_name, dod, amount_minor, currency, state)
  values ('backfill self-test: no acceptance', '["self-test"]'::jsonb, 1, 'JPY', 'DRAFTING')
  returning id into v_contract;

  if pg_temp.accepted_snapshot_version(v_contract) is not null then
    raise exception 'SELF-TEST FAILED: a contract with no acceptance got a version'
      using errcode = 'TF900';
  end if;

  -- Each case below gets its own contract, an acceptance carrying the payload
  -- under test, and an assertion on what comes back.
  declare
    cases jsonb[] := array[
      -- {payload, expected}  expected null means "must stay NULL"
      '{"_agreement": {"snapshot_version": 1}}'::jsonb,                    -- valid
      '{"_agreement": {}}'::jsonb,                                         -- missing version
      '{"_agreement": {"snapshot_version": "abc"}}'::jsonb,                -- malformed
      '{"_agreement": {"snapshot_version": "1"}}'::jsonb,                  -- the STRING "1"
      '{"_agreement": {"snapshot_version": 99999999999999999999}}'::jsonb, -- overflows integer
      '{"_agreement": {"snapshot_version": 1.5}}'::jsonb,                  -- not integral
      '{"_agreement": {"snapshot_version": null}}'::jsonb,                 -- JSON null
      '{}'::jsonb                                                          -- no _agreement
    ];
    expected integer[] := array[1, null, null, null, null, null, null, null];
    i int;
  begin
    for i in 1 .. array_length(cases, 1) loop
      insert into public.contracts (project_name, dod, amount_minor, currency, state)
      values ('backfill self-test case ' || i, '["self-test"]'::jsonb, 1, 'JPY', 'TERMS_ACCEPTED')
      returning id into v_contract;

      insert into public.events (type, contract_id, actor_id, created_at, event_hash, payload)
      values ('dod.consent_recorded', v_contract::text, 'migration-self-test',
              v_at, 'self-test-case-' || i, cases[i]);

      v_got := pg_temp.accepted_snapshot_version(v_contract);

      if v_got is distinct from expected[i] then
        raise exception 'SELF-TEST FAILED: case % gave %, expected %',
          i, coalesce(v_got::text, 'NULL'), coalesce(expected[i]::text, 'NULL')
          using errcode = 'TF900';
      end if;
    end loop;
  end;

  -- THE ORDERING CASE. Two acceptances on one contract: the EARLIEST has no
  -- usable version and a LATER one is valid. The answer must be NULL — the
  -- earliest is the one the Edge Function reads and refuses on, so promoting
  -- the later one would make this column disagree with the code it is meant to
  -- replace. This is the case the first version of the migration got wrong.
  insert into public.contracts (project_name, dod, amount_minor, currency, state)
  values ('backfill self-test: earliest invalid', '["self-test"]'::jsonb, 1, 'JPY', 'TERMS_ACCEPTED')
  returning id into v_contract;

  insert into public.events (type, contract_id, actor_id, created_at, event_hash, payload)
  values ('dod.consent_recorded', v_contract::text, 'migration-self-test',
          v_at, 'self-test-order-a', '{"_agreement": {"snapshot_version": "1"}}'::jsonb);

  insert into public.events (type, contract_id, actor_id, created_at, event_hash,
                             prev_event_hash, payload)
  values ('dod.consent_recorded', v_contract::text, 'migration-self-test',
          v_at + interval '1 second', 'self-test-order-b', 'self-test-order-a',
          '{"_agreement": {"snapshot_version": 1}}'::jsonb);

  if pg_temp.accepted_snapshot_version(v_contract) is not null then
    raise exception 'SELF-TEST FAILED: a later valid acceptance overrode an invalid earliest one'
      using errcode = 'TF900';
  end if;

  -- And the control, so the NULLs above are refusals of what they name rather
  -- than this function always returning NULL: earliest valid, later invalid.
  insert into public.contracts (project_name, dod, amount_minor, currency, state)
  values ('backfill self-test: earliest valid', '["self-test"]'::jsonb, 1, 'JPY', 'TERMS_ACCEPTED')
  returning id into v_contract;

  insert into public.events (type, contract_id, actor_id, created_at, event_hash, payload)
  values ('dod.consent_recorded', v_contract::text, 'migration-self-test',
          v_at, 'self-test-order-c', '{"_agreement": {"snapshot_version": 1}}'::jsonb);

  insert into public.events (type, contract_id, actor_id, created_at, event_hash,
                             prev_event_hash, payload)
  values ('dod.consent_recorded', v_contract::text, 'migration-self-test',
          v_at + interval '1 second', 'self-test-order-d', 'self-test-order-c',
          '{"_agreement": {"snapshot_version": "nonsense"}}'::jsonb);

  if pg_temp.accepted_snapshot_version(v_contract) is distinct from 1 then
    raise exception 'SELF-TEST FAILED: a valid earliest acceptance was not read'
      using errcode = 'TF900';
  end if;

  -- TWO ACCEPTANCES SHARING A TIMESTAMP. Codex's finding 1 on the Task 30
  -- re-review: this file ordered by (created_at, id) while the runtime reader
  -- ordered by created_at alone, so on a tie the two could pick different rows
  -- and the cached column would disagree with the refusal the writers were
  -- already making. Both order by (created_at, id) now, and this is the case
  -- that pins it.
  --
  -- The trigger has to come off to build the fixture, and that is the point
  -- rather than a workaround: `events_require_monotonic_created_at`
  -- (20261108121500) refuses an event whose created_at is not strictly later
  -- than the last on its contract, so a tie cannot be CREATED today. It can
  -- still be READ — rows written before that trigger existed are exactly why
  -- it was added — and this backfill reads history. Disabling it here models
  -- those grandfathered rows; the rollback below puts it back, and the DDL is
  -- transactional so a failure part-way cannot leave it off.
  insert into public.contracts (project_name, dod, amount_minor, currency, state)
  values ('backfill self-test: tied stamps, lower id invalid', '["self-test"]'::jsonb,
          1, 'JPY', 'TERMS_ACCEPTED')
  returning id into v_contract;

  alter table public.events disable trigger events_require_monotonic_created_at;

  -- Same instant. The LOWER id carries the malformed version, so the answer
  -- must be NULL: id breaks the tie, and the lower one wins.
  insert into public.events (id, type, contract_id, actor_id, created_at, event_hash, payload)
  values ('00000000-0000-4000-8000-00000000aaaa', 'dod.consent_recorded', v_contract::text,
          'migration-self-test', v_at, 'self-test-tie-a',
          '{"_agreement": {"snapshot_version": "1"}}'::jsonb);

  insert into public.events (id, type, contract_id, actor_id, created_at, event_hash,
                             prev_event_hash, payload)
  values ('00000000-0000-4000-8000-00000000bbbb', 'dod.consent_recorded', v_contract::text,
          'migration-self-test', v_at, 'self-test-tie-b', 'self-test-tie-a',
          '{"_agreement": {"snapshot_version": 1}}'::jsonb);

  if pg_temp.accepted_snapshot_version(v_contract) is not null then
    raise exception 'SELF-TEST FAILED: on tied stamps a higher-id acceptance overrode the lower one'
      using errcode = 'TF900';
  end if;

  -- The control, so the NULL above is the tie-break and not the tie itself:
  -- same instant, and this time the LOWER id is the valid one.
  insert into public.contracts (project_name, dod, amount_minor, currency, state)
  values ('backfill self-test: tied stamps, lower id valid', '["self-test"]'::jsonb,
          1, 'JPY', 'TERMS_ACCEPTED')
  returning id into v_contract;

  insert into public.events (id, type, contract_id, actor_id, created_at, event_hash, payload)
  values ('00000000-0000-4000-8000-00000000cccc', 'dod.consent_recorded', v_contract::text,
          'migration-self-test', v_at, 'self-test-tie-c',
          '{"_agreement": {"snapshot_version": 1}}'::jsonb);

  insert into public.events (id, type, contract_id, actor_id, created_at, event_hash,
                             prev_event_hash, payload)
  values ('00000000-0000-4000-8000-00000000dddd', 'dod.consent_recorded', v_contract::text,
          'migration-self-test', v_at, 'self-test-tie-d', 'self-test-tie-c',
          '{"_agreement": {"snapshot_version": 2}}'::jsonb);

  if pg_temp.accepted_snapshot_version(v_contract) is distinct from 1 then
    raise exception 'SELF-TEST FAILED: on tied stamps the lower-id acceptance was not read'
      using errcode = 'TF900';
  end if;

  alter table public.events enable trigger events_require_monotonic_created_at;

  -- And the documented behaviour of finding 2, asserted so the comment cannot
  -- drift from the code: an unsupported NUMBER is kept, not nulled. The
  -- consumer refuses it; this column records what the acceptance said.
  insert into public.contracts (project_name, dod, amount_minor, currency, state)
  values ('backfill self-test: unsupported number kept', '["self-test"]'::jsonb,
          1, 'JPY', 'TERMS_ACCEPTED')
  returning id into v_contract;

  insert into public.events (type, contract_id, actor_id, created_at, event_hash, payload)
  values ('dod.consent_recorded', v_contract::text, 'migration-self-test',
          v_at, 'self-test-unsupported', '{"_agreement": {"snapshot_version": 2}}'::jsonb);

  if pg_temp.accepted_snapshot_version(v_contract) is distinct from 2 then
    raise exception 'SELF-TEST FAILED: an unsupported numeric version was not preserved as recorded'
      using errcode = 'TF900';
  end if;

  raise exception 'self-test complete' using errcode = 'TF901';
exception
  when sqlstate 'TF901' then null;
end $$;
