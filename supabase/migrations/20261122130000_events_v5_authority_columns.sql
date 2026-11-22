-- Row 3: additive storage for the v5 authority pair (Decisions.md C2, (c);
-- docs/v5-preimage-review.md; Codex T160 must-haves 1–3).
--
-- Schema only. v5 WRITES STAY DISABLED: `events_v5_writes_disabled` refuses any
-- row recorded as v5. The legacy writers (accept_invitation, append_guest_event,
-- reissue_guest_access) build rows with jsonb_populate_record(null::events, …),
-- which from now on would fill these columns from any JSON that carries them;
-- without the gate a server bug could commit a v5 row through a generic writer.
-- The migration that installs the dedicated, versioned v5 entry point (with its
-- in-transaction RETURNING comparison and grant check, T160 items 4–5) drops the
-- gate in the same transaction. Nothing else here changes behaviour.
--
-- What does not change: no default, no backfill, no index, no rewrite of any
-- historical value or hash; existing grants, RLS, rules (no_update_events /
-- no_delete_events already cover every column) and legacy functions are
-- untouched. Old rows and old insert payloads read back both columns as null.
--
-- Constraint null semantics are explicit: a CHECK accepts UNKNOWN, so every
-- predicate below is total (IS [NOT] DISTINCT FROM, explicit IS NOT NULL).

alter table public.events
  add column credential_id uuid,
  add column issuer_kind text;

-- Existence and retention only. It does not prove the grant matches the deal,
-- issuer, scope or expiry; the v5 writer checks those under its lock.
alter table public.events
  add constraint events_credential_id_fkey
    foreign key (credential_id) references public.entry_agent_credentials(id) on delete restrict;

alter table public.events
  add constraint events_issuer_kind_check
    check (issuer_kind is null or issuer_kind in ('owner_account', 'counterpart_account'));

-- Both on v5, neither on every other version (including a null version).
alter table public.events
  add constraint events_v5_authority_pair
    check (
      (hash_version is not distinct from 5 and credential_id is not null and issuer_kind is not null)
      or
      (hash_version is distinct from 5 and credential_id is null and issuer_kind is null)
    );

-- A v5 row names its predecessor explicitly: GENESIS or a lowercase digest.
-- Whether GENESIS is truly the first link is chain state, not row state.
alter table public.events
  add constraint events_v5_prev_link
    check (
      hash_version is distinct from 5
      or (prev_event_hash is not null
          and (prev_event_hash = 'GENESIS' or prev_event_hash ~ '^[0-9a-f]{64}$'))
    );

alter table public.events
  add constraint events_v5_writes_disabled
    check (hash_version is distinct from 5);

-- Apply-time self-test: any failure rolls the whole migration back.
do $$
declare
  r text;
  p text;
  col text;
begin
  if exists (
    select 1 from pg_attribute
    where attrelid = 'public.events'::regclass and attname in ('credential_id', 'issuer_kind')
      and (attnotnull or atthasdef)
  ) or (select count(*) from pg_attribute
        where attrelid = 'public.events'::regclass and attname in ('credential_id', 'issuer_kind')
          and not attisdropped) <> 2 then
    raise exception 'SELF-TEST FAILED: authority columns must exist, nullable, without default';
  end if;

  if (select confdeltype from pg_constraint
      where conrelid = 'public.events'::regclass and conname = 'events_credential_id_fkey') is distinct from 'r'
     or (select confrelid from pg_constraint
         where conrelid = 'public.events'::regclass and conname = 'events_credential_id_fkey')
        is distinct from 'public.entry_agent_credentials'::regclass then
    raise exception 'SELF-TEST FAILED: credential FK must reference entry_agent_credentials ON DELETE RESTRICT';
  end if;

  if (select count(*) from pg_constraint
      where conrelid = 'public.events'::regclass and convalidated
        and conname in ('events_credential_id_fkey', 'events_issuer_kind_check', 'events_v5_authority_pair',
                        'events_v5_prev_link', 'events_v5_writes_disabled')) <> 5 then
    raise exception 'SELF-TEST FAILED: a new events constraint is missing or not validated';
  end if;

  if exists (select 1 from public.events where credential_id is not null or issuer_kind is not null) then
    raise exception 'SELF-TEST FAILED: an existing event carries authority values';
  end if;

  -- Effective privileges, so PUBLIC and inherited grants count.
  foreach r in array array['anon', 'authenticated', 'public'] loop
    foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(r, 'public.events', p) then
        raise exception 'SELF-TEST FAILED: % has % on events', r, p;
      end if;
    end loop;
    foreach col in array array['credential_id', 'issuer_kind'] loop
      if has_column_privilege(r, 'public.events', col, 'INSERT')
         or has_column_privilege(r, 'public.events', col, 'UPDATE') then
        raise exception 'SELF-TEST FAILED: % may write events.%', r, col;
      end if;
    end loop;
    if has_any_column_privilege(r, 'public.entry_agent_credentials', 'SELECT') then
      raise exception 'SELF-TEST FAILED: % can read entry_agent_credentials', r;
    end if;
  end loop;

  if not (select relrowsecurity from pg_class where oid = 'public.events'::regclass) then
    raise exception 'SELF-TEST FAILED: events RLS is off';
  end if;
end $$;
