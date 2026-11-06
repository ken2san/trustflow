-- docs/proposals/20261106000000_runtime_snapshot_bounds.sql.draft
--
-- Bound what runtime_snapshots can hold, in the database rather than only in
-- the browser.
--
-- WHY
-- The allowlist that narrowed these rows to {hasOnboarded, mode, view,
-- savedAt} lives entirely in the client (src/lib/runtimeState.js:90-95,
-- cloudSafeSubset at :133). The table's own policy constrains only ownership
-- (20260924000000_runtime_snapshots_table.sql:35-46): any authenticated
-- session — including an anonymous one, which Supabase gives the
-- `authenticated` role — may insert arbitrary JSON of any size into its own
-- actor_id, as many times as it likes. The 94-byte row measured on 2026-11-06
-- is what the app sends, not what the API permits.
--
-- Two separate limits, because they fail differently:
--   1. SHAPE and SIZE — a CHECK, so a row outside the allowlist is rejected by
--      the database and the claim "only these four keys leave the browser"
--      stops depending on the client being the only writer.
--   2. COUNT — one row per actor, via a unique index and an upsert. 1161 rows
--      existed for 171 actors because the client INSERTs and never UPSERTs
--      (runtimeState.js:237), while the reader only ever wants the latest.
--      History here has no reader and no retention bound.
--
-- NOT a security boundary against a determined caller: it bounds damage, it
-- does not authenticate anyone. The point is that the bound is enforced where
-- the data lands.

begin;

-- 0. The precondition, carried by the migration rather than left to whoever
--    runs it.
--
--    Measured 2026-11-06 before writing this: E2E holds 282 rows of which 276
--    fail the key check and 261 are superseded duplicates, and production
--    holds 3 rows which all pass the shape checks but include 2 duplicates.
--    So neither project can take the constraints below as they stand — ADD
--    CONSTRAINT validates existing rows, and a unique index cannot be built
--    over duplicates.
--
--    Deleting them loses nothing that is read. loadRuntimeSnapshot takes
--    `order by created_at desc limit 1`, so every row but the newest per actor
--    has no reader at all, and a row in the pre-allowlist shape is one the
--    client already refuses to rehydrate (filterToShape strips it on the way
--    in as well as out — see runtimeState.js). What is removed is state a
--    browser can rebuild by existing.
--
--    This is destructive and deliberate. It is confined to runtime_snapshots,
--    which is application state and not evidence: no hashes, no chain, no
--    contractual meaning. `contracts` and `events` are untouched.

-- Anything the allowlist does not admit, which the client would discard anyway.
delete from runtime_snapshots
where payload - array['hasOnboarded', 'mode', 'view', 'savedAt'] <> '{}'::jsonb
   or length(payload::text) > 512;

-- Every row but the newest per actor, which is the only one anything reads.
delete from runtime_snapshots a
where exists (
  select 1 from runtime_snapshots b
  where b.actor_id = a.actor_id
    and (b.created_at, b.id) > (a.created_at, a.id)
);

-- 1a. Shape: nothing outside the allowlist, at the top level.
--     `payload - keys` removes those keys; whatever remains was not allowed.
alter table runtime_snapshots
  add constraint runtime_snapshot_allowlisted_keys
  check (
    payload - array['hasOnboarded', 'mode', 'view', 'savedAt'] = '{}'::jsonb
  );

-- 1b. Size: generous against the four scalars it may hold, and four orders of
--     magnitude below what an unbounded jsonb column would accept.
alter table runtime_snapshots
  add constraint runtime_snapshot_size_bound
  check (length(payload::text) <= 512);

-- 1c. Types, so `view` cannot carry a document in a string.
alter table runtime_snapshots
  add constraint runtime_snapshot_leaf_types
  check (
    (payload -> 'hasOnboarded' is null or jsonb_typeof(payload -> 'hasOnboarded') = 'boolean')
    and (payload -> 'mode' is null or (jsonb_typeof(payload -> 'mode') = 'string' and length(payload ->> 'mode') <= 32))
    and (payload -> 'view' is null or (jsonb_typeof(payload -> 'view') = 'string' and length(payload ->> 'view') <= 64))
    and (payload -> 'savedAt' is null or (jsonb_typeof(payload -> 'savedAt') = 'string' and length(payload ->> 'savedAt') <= 32))
  );

-- 2. One row per actor. Requires the client to upsert on actor_id; until it
--    does, a second insert for the same actor fails rather than accumulating.
--    Deliberately ordered after the deletion of the historical rows
--    (2026-11-06), which is what makes the index creatable at all.
create unique index if not exists runtime_snapshots_one_per_actor
  on runtime_snapshots (actor_id);

commit;
