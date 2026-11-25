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
-- Preconditions are checked first and fail the whole migration: B's triggers,
-- trigger functions and ACLs in place, the gate row present and CLOSED, and the
-- CHECK present. The gate row is held FOR SHARE through commit, so a concurrent
-- open waits for this migration and the CHECK is never dropped under an open
-- gate. No row is changed.
--
-- Rollback (stops new writes only): close the gate; optionally re-add the CHECK
-- as `check (hash_version is distinct from 5) not valid` if v5 rows exist.

-- ── Preconditions ───────────────────────────────────────────────────────────
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

  -- Both ticket triggers present and enabled; the BEFORE one sorts last.
  if (select count(*) from pg_trigger where tgrelid = 'public.events'::regclass and tgenabled = 'O'
        and tgname in ('zz_v5_write_ticket_check', 'v5_write_ticket_confirm')) <> 2
     or (select max(tgname::text collate "C") from pg_trigger t
          where t.tgrelid = 'public.events'::regclass and not t.tgisinternal
            and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4) is distinct from 'zz_v5_write_ticket_check' then
    raise exception 'PRECONDITION FAILED: the v5 ticket triggers are missing, disabled or misordered'
      using errcode = 'TF953';
  end if;

  -- The trigger functions are the narrow privileged code: definer, empty
  -- search_path, no EXECUTE for any API role.
  if (select count(*) from pg_proc
      where oid in ('private.v5_write_ticket_check()'::regprocedure, 'private.v5_write_ticket_confirm()'::regprocedure)
        and prosecdef and proconfig = array['search_path=""']) <> 2 then
    raise exception 'PRECONDITION FAILED: a ticket trigger function is not definer with an empty search_path'
      using errcode = 'TF954';
  end if;
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'private.v5_write_ticket_check()', 'EXECUTE')
       or has_function_privilege(r, 'private.v5_write_ticket_confirm()', 'EXECUTE')
       or has_table_privilege(r, 'private.v5_write_tickets', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege(r, 'private.v5_write_gate', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'PRECONDITION FAILED: % holds a privilege on the v5 ticket or gate objects', r
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
