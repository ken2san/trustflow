-- Row 4 migration C (docs/plans/row4-owner-append.md §4c, Q5 (c), Codex T188):
-- drop `events_v5_writes_disabled`, the CHECK that refused every v5 row.
--
-- v5 WRITES STAY CLOSED after this migration. What still refuses them, each on
-- its own, is the database confinement migration B added while the CHECK was
-- present:
--   * the closed gate row `private.v5_write_gate` (writer: `gate_closed`;
--     ticket trigger: TF013; a missing row TF012);
--   * the one-use write tickets: `zz_v5_write_ticket_check` (BEFORE, TF011 for
--     any v5-shaped row without a ticket) and `v5_write_ticket_confirm` (AFTER,
--     TF014 for a stored v5-shaped row without a used ticket).
-- Opening is a separate, per-project data change (`update private.v5_write_gate
-- set open = true`), never part of a migration. Production's gate stays closed.
--
-- Locks first (Codex T210): `public.events` ACCESS EXCLUSIVE, the mode the drop
-- needs anyway, so no trigger DDL on the table can commit between the checks
-- and the drop; then the gate row FOR SHARE, so a concurrent open waits for this
-- migration and the CHECK is never dropped under an open gate. Both are held
-- through commit. This order cannot deadlock with the writer, which takes the
-- gate FOR SHARE (compatible) before it inserts into events.
--
-- Preconditions are then checked and fail the whole migration: the gate row
-- present and CLOSED, the CHECK present, each ticket trigger exactly as B
-- created it (function, row-level BEFORE/AFTER INSERT, WHEN, not deferrable,
-- enabled, the BEFORE one sorting last), the trigger functions B's code as
-- definer with an empty search_path, and no API role holding a privilege on
-- the trigger functions or on the ticket and gate tables, column grants
-- included. GRANT/REVOKE and CREATE OR REPLACE FUNCTION take no table lock, so
-- ACL and function maintenance on these objects must not run during the apply.
-- No row is changed.
--
-- Rollback (stops new writes only): close the gate; optionally re-add the CHECK
-- as `check (hash_version is distinct from 5) not valid` if v5 rows exist.

-- ── Locks, then preconditions ───────────────────────────────────────────────
lock table public.events in access exclusive mode;

do $$
declare
  v_open boolean;
  r text;
begin
  -- The gate row exists and is closed, held FOR SHARE until commit.
  select w.open into v_open from private.v5_write_gate w where w.id for share;
  if not found then
    raise exception 'PRECONDITION FAILED: the v5 write gate row is missing' using errcode = 'TF951';
  end if;
  if v_open then
    raise exception 'PRECONDITION FAILED: the v5 write gate is open; close it before dropping the CHECK'
      using errcode = 'TF951';
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass
                  and conname = 'events_v5_writes_disabled') then
    raise exception 'PRECONDITION FAILED: events_v5_writes_disabled is not present' using errcode = 'TF952';
  end if;

  -- Each ticket trigger exactly as B created it: bound to its function,
  -- row-level BEFORE INSERT (tgtype 7) / AFTER INSERT (5), B's WHEN, enabled,
  -- not a constraint or deferrable trigger, no arguments.
  if (select count(*) from pg_trigger t
      where t.tgrelid = 'public.events'::regclass and not t.tgisinternal and t.tgenabled = 'O'
        and not t.tgdeferrable and not t.tginitdeferred and t.tgconstraint = 0 and t.tgnargs = 0
        and ((t.tgname = 'zz_v5_write_ticket_check' and t.tgtype = 7
              and t.tgfoid = to_regprocedure('private.v5_write_ticket_check()')
              and pg_get_triggerdef(t.oid) = 'CREATE TRIGGER zz_v5_write_ticket_check BEFORE INSERT ON public.events '
                || 'FOR EACH ROW WHEN (((NOT (new.hash_version IS DISTINCT FROM 5)) OR (new.credential_id IS NOT NULL) '
                || 'OR (new.issuer_kind IS NOT NULL))) EXECUTE FUNCTION private.v5_write_ticket_check()')
          or (t.tgname = 'v5_write_ticket_confirm' and t.tgtype = 5
              and t.tgfoid = to_regprocedure('private.v5_write_ticket_confirm()')
              and pg_get_triggerdef(t.oid) = 'CREATE TRIGGER v5_write_ticket_confirm AFTER INSERT ON public.events '
                || 'FOR EACH ROW WHEN (((NOT (new.hash_version IS DISTINCT FROM 5)) OR (new.credential_id IS NOT NULL) '
                || 'OR (new.issuer_kind IS NOT NULL))) EXECUTE FUNCTION private.v5_write_ticket_confirm()'))) <> 2
     or (select max(tgname::text collate "C") from pg_trigger t
          where t.tgrelid = 'public.events'::regclass and not t.tgisinternal
            and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4) is distinct from 'zz_v5_write_ticket_check' then
    raise exception 'PRECONDITION FAILED: a v5 ticket trigger is missing, disabled, misordered or differs from migration B'
      using errcode = 'TF953';
  end if;

  -- The trigger functions are B's code, the narrow privileged path: definer,
  -- empty search_path, body unchanged (md5 of prosrc as B created it), no
  -- EXECUTE for any API role.
  if (select count(*) from pg_proc
      where prosecdef and proconfig = array['search_path=""']
        and ((oid = to_regprocedure('private.v5_write_ticket_check()') and md5(prosrc) = '86efed6771c8e13f8ec7580812fab78b')
          or (oid = to_regprocedure('private.v5_write_ticket_confirm()') and md5(prosrc) = '6bc80ba3eab3a8a29f49bc5e1a61f192'))) <> 2 then
    raise exception 'PRECONDITION FAILED: a ticket trigger function is not definer with an empty search_path, or its body differs from migration B'
      using errcode = 'TF954';
  end if;
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'private.v5_write_ticket_check()', 'EXECUTE')
       or has_function_privilege(r, 'private.v5_write_ticket_confirm()', 'EXECUTE')
       or has_table_privilege(r, 'private.v5_write_tickets', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege(r, 'private.v5_write_gate', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_any_column_privilege(r, 'private.v5_write_tickets', 'SELECT,INSERT,UPDATE,REFERENCES')
       or has_any_column_privilege(r, 'private.v5_write_gate', 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'PRECONDITION FAILED: % holds a privilege (table, column or EXECUTE) on the v5 ticket or gate objects', r
        using errcode = 'TF955';
    end if;
  end loop;
end
$$;

-- ── The change ──────────────────────────────────────────────────────────────
alter table public.events drop constraint events_v5_writes_disabled;

-- ── Apply-time self-test: any failure rolls the whole migration back ───────
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.events'::regclass
              and conname = 'events_v5_writes_disabled') then
    raise exception 'SELF-TEST FAILED: events_v5_writes_disabled is still present' using errcode = 'TF956';
  end if;
  -- The other v5 constraints are untouched and still validated.
  if (select count(*) from pg_constraint
      where conrelid = 'public.events'::regclass and convalidated
        and conname in ('events_credential_id_fkey', 'events_issuer_kind_check', 'events_v5_authority_pair',
                        'events_v5_prev_link')) <> 4 then
    raise exception 'SELF-TEST FAILED: another v5 events constraint is missing or not validated'
      using errcode = 'TF957';
  end if;
  if (select open from private.v5_write_gate) is distinct from false then
    raise exception 'SELF-TEST FAILED: the v5 write gate is not closed' using errcode = 'TF958';
  end if;
end
$$;
