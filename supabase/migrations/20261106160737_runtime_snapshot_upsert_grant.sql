-- An upsert needs UPDATE. The previous migration gave the table one row per
-- actor without giving anyone the right to replace it.
--
-- HOW THIS SHIPPED
-- 20261106160059 added `create unique index ... (actor_id)` and the client
-- moved from INSERT to `upsert(..., { onConflict: 'actor_id' })` in the same
-- breath. `INSERT ... ON CONFLICT DO UPDATE` requires the UPDATE privilege,
-- and this table had only ever granted INSERT and SELECT:
--
--   authenticated -> INSERT, REFERENCES, SELECT, TRIGGER
--
-- so every save after the first answered `permission denied for table
-- runtime_snapshots`, swallowed by saveRuntimeSnapshot's console warning —
-- the degradation that is correct for a snapshot and useless for noticing.
-- Caught by loading the deployed site and reading the console, not by any
-- test: the container check that verified the constraints runs as `postgres`,
-- where privileges do not exist. A superuser cannot test a grant.
--
-- WHO THIS GRANTS TO
-- `authenticated`, which is NOT the same as "people with accounts". A Supabase
-- anonymous sign-in also runs as `authenticated` — the roles differ from the
-- `anon` Postgres role, which is the unauthenticated API key. This app no
-- longer mints an anonymous user on page load (identity.js), but one is
-- created at the email claim, and that session is covered by this grant.
-- Restricting cloud snapshots to verified accounts would mean an
-- `is_anonymous` condition on all three policies, and is a product decision
-- nobody has made. Noted by Codex's review, which caught the original comment
-- here implying anonymous callers were excluded.
--
-- WHAT IT GRANTS
-- Two columns, not the table. `id` and `created_at` are the row's identity and
-- its age, neither of which a client has any reason to rewrite, and a bare
-- `grant update on runtime_snapshots` would have handed over both. The upsert
-- sends exactly `actor_id` and `payload`, so that is the grant.
--
-- The policy then bounds which rows: `using` decides what may be replaced and
-- `with check` what it may become, and both pin actor_id to the caller — so a
-- session can replace its own snapshot and cannot move a row onto another
-- actor. Postgres would reuse `using` for `with check` if it were omitted;
-- both are written out because the two questions are different and a reader
-- should not have to know that rule.

begin;

grant update (actor_id, payload) on runtime_snapshots to authenticated;

create policy own_runtime_snapshot_update on runtime_snapshots
  for update to authenticated
  using (actor_id = (auth.uid())::text)
  with check (actor_id = (auth.uid())::text);

-- A byte ceiling that was counting characters.
--
-- 20261106160059 wrote `length(payload::text) <= 512` and called it a
-- 512-byte bound in its own comment. `length` counts characters, so a payload
-- of multibyte text passes it at well over 512 bytes. The leaf-type checks
-- already hold each field far below this, which is why nothing failed — the
-- defect is that the constraint did not say what the comment said it did, and
-- this project has paid for that class of mismatch before. Also found by
-- Codex's review.
alter table runtime_snapshots drop constraint runtime_snapshot_size_bound;
alter table runtime_snapshots
  add constraint runtime_snapshot_size_bound
  check (octet_length(payload::text) <= 512);

commit;
