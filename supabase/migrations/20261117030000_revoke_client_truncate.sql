-- Revoke TRUNCATE from the client roles on the two tables that still hold it.
--
-- WHY
-- Supabase grants every privilege on a new public table to `anon` and
-- `authenticated` by default. The lockdown migrations revoked the row-writing
-- privileges table by table, and three of them also revoked TRUNCATE
-- (events: 20260924000002; runtime_snapshots: 20260924000000; trustpoints_ledger:
-- 20260924000003). Two did not:
--
--   contracts               20260923000000 revoked insert, update, delete only.
--                           Measured on E2E 2026-11-16 (Task 105, read-only
--                           catalog query): anon held REFERENCES, SELECT,
--                           TRIGGER, TRUNCATE; authenticated also DELETE.
--   earner_payout_profiles  20260921000001 revoked nothing, so it keeps the same
--                           defaults (inferred from the migrations; this table's
--                           grants were not part of that query).
--
-- TRUNCATE is not subject to row-level security, rules or row triggers: a client
-- role holding it could empty the table wholesale. PostgREST exposes no TRUNCATE,
-- so it is reachable only through a SQL session as that role — a defence-in-depth
-- gap, not a known exposure. Closed here because nothing intends it.
--
-- WHAT THIS DOES NOT CHANGE
-- Only TRUNCATE, only for anon and authenticated. SELECT, the column-level INSERT
-- grants and DELETE on contracts (owner_delete_unaccepted_draft needs it) stay.
-- REFERENCES and TRIGGER are the same unintended default on every table and are
-- left for a separate, all-tables cleanup rather than half done here.
--
-- Idempotent: revoking a privilege a role does not hold is a no-op.

revoke truncate on table public.contracts              from anon, authenticated;
revoke truncate on table public.earner_payout_profiles from anon, authenticated;

-- Apply-time check, read-only: no client role may hold TRUNCATE on any of the
-- five public tables, the three revoked earlier included. Fails the migration
-- (and rolls it back) rather than leaving a gap unnoticed.
do $$
declare
  t text;
  r text;
begin
  foreach t in array array['contracts', 'earner_payout_profiles', 'events',
                           'runtime_snapshots', 'trustpoints_ledger'] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_table_privilege(r, format('public.%I', t), 'TRUNCATE') then
        raise exception 'SELF-TEST FAILED: % still holds TRUNCATE on public.%', r, t
          using errcode = 'TF900';
      end if;
    end loop;
  end loop;
end
$$;
