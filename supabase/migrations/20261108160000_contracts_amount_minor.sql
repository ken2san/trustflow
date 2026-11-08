-- The amount becomes `amount_minor`, in the currency's own minor unit.
--
-- WHY
-- TrustFlow was JPY-only and the column said so: `amount_jpy`, with a CHECK
-- that `currency = 'JPY'`. Kenji transacts in Canada, Hong Kong and Japan, so
-- that is now wrong for real use (decision 2026-11-08: record the CURRENCY,
-- and not the country — there is no use for a country until tax or
-- jurisdiction exists). The allowed list lives in
-- supabase/functions/_shared/money.ts; this file and the one after it are the
-- database's copy of it.
--
-- THIS MIGRATION DOES NOT ALLOW A SECOND CURRENCY. It only adds the column and
-- fills it. `contracts_currency_check` still says 'JPY' when this file
-- finishes, and the next migration (20261108161000) widens it. That order is
-- the point:
--
--   1. this migration        — amount_minor exists, equals amount_jpy on every
--                              row, and is exposed by both acceptance
--                              functions. Readers still on amount_jpy are
--                              unaffected; readers on amount_minor work.
--   2. deploy Edge Functions — every reader moves to amount_minor.
--   3. 20261108161000        — the six currencies become legal, and amount_jpy
--                              becomes NULL for rows that are not JPY.
--
-- Reversed, step 3 before step 2, a CAD contract would be read by a function
-- that still asks for amount_jpy, get NULL, and hash an agreement snapshot
-- with no amount in it. The window where that is possible is closed by not
-- opening it.
--
-- EXISTING ROWS MEAN EXACTLY WHAT THEY MEANT
-- `amount_minor` is backfilled from `amount_jpy`, and JPY has no minor unit, so
-- for every row that exists the two are the same integer. The agreement
-- snapshot (eventCanonical.ts) has always hashed that integer under the key
-- `amount`, so every stored agreement_hash recomputes to the same digest and
-- `snapshot_version` stays at 1. Nothing is reinterpreted and nothing is
-- versioned, because nothing changed: a 1466-row-JPY history is the same
-- history whether the column is called yen or minor units.
--
-- WHY amount_jpy STAYS, AND WHY A CHECK TIES THEM TOGETHER
-- It stays readable so that an Edge Function deployed before this migration
-- keeps working, which is what makes the three steps above safe to take one at
-- a time. While it is still read, the two columns must not be able to
-- disagree — a row where amount_jpy said 300000 and amount_minor said 3000
-- would be two different deals depending on which reader looked. The CHECK
-- makes that unrepresentable rather than merely unlikely. The next migration
-- replaces it with the per-currency form.
--
-- amount_minor IS ADDED TO freeze_accepted_terms
-- That trigger is defence in depth around the agreed terms, and the agreed
-- amount is now in a column it did not know about. Today the mirror CHECK
-- would also stop a lone amount_minor edit; after the next migration it would
-- not, because a non-JPY row has no amount_jpy to disagree with. Adding it here
-- rather than there keeps the window closed for the whole sequence.

begin;

-- ── 1. The column ───────────────────────────────────────────────────────────
alter table contracts add column if not exists amount_minor integer;

comment on column contracts.amount_minor is
  'The agreed amount as an integer in `currency`''s minor unit: yen for JPY, '
  'cents for CAD/HKD/USD/EUR/GBP. Hashed into every event through the '
  'agreement snapshot. See supabase/functions/_shared/money.ts.';

comment on column contracts.amount_jpy is
  'DEPRECATED 2026-11-08, kept readable during the amount_minor transition. '
  'Equal to amount_minor on a JPY contract and NULL on any other. Drop it once '
  'no deployed reader asks for it.';

-- No WHERE clause and no rounding: JPY has no minor unit, so the value is
-- already in minor units and this is a rename performed as a copy.
update contracts set amount_minor = amount_jpy where amount_minor is null;

alter table contracts alter column amount_minor set not null;

alter table contracts drop constraint if exists contracts_amount_minor_positive_check;
alter table contracts
  add constraint contracts_amount_minor_positive_check
  check (amount_minor > 0);

-- The transitional invariant. Replaced in 20261108161000.
alter table contracts drop constraint if exists contracts_amount_jpy_mirror_check;
alter table contracts
  add constraint contracts_amount_jpy_mirror_check
  check (amount_jpy = amount_minor);

-- ── 2. A writer that has never heard of it still works ─────────────────────
--
-- WITHOUT THIS, THE MIGRATION BREAKS CONTRACT CREATION THE MOMENT IT COMMITS.
-- `amount_minor` is NOT NULL with no default, and every browser running a
-- bundle from before today sends `amount_jpy` alone (src/lib/contracts.js
-- before 5156225). Those inserts would fail with 23502 until the person
-- reloaded — between this migration and the frontend deploy for certain, and
-- afterwards for anyone on a cached bundle. Codex found this, 2026-11-08; the
-- three-step order in the header did not save it, because the break starts at
-- step 1.
--
-- So the server fills the new column from the old one when a caller omits it.
-- This is correct and not a guess: it only ever fires for a row whose currency
-- is JPY, where the two columns are the same integer by CHECK, and the
-- 20261108161000 mirror makes any other currency with an amount_jpy
-- unrepresentable anyway. A row supplying neither still fails NOT NULL, which
-- is the right answer rather than a zero.
--
-- It is transitional and dies with the column: drop this trigger in the same
-- migration that drops amount_jpy.
create or replace function public.fill_amount_minor_from_legacy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.amount_minor is null then
    new.amount_minor := new.amount_jpy;
  end if;
  return new;
end;
$$;

drop trigger if exists contracts_fill_amount_minor on contracts;
create trigger contracts_fill_amount_minor
  before insert on contracts
  for each row
  execute function public.fill_amount_minor_from_legacy();

revoke execute on function public.fill_amount_minor_from_legacy() from public, anon, authenticated;

-- ── 3. The client may supply it ─────────────────────────────────────────────
-- Table-level INSERT was revoked in 20260923000000 and re-granted per column,
-- and a column added later is not covered by that grant. Without this line the
-- browser's insert fails with 403 on the one field this whole change is about.
grant insert (amount_minor) on contracts to authenticated;

-- ── 4. The freeze trigger learns the new column ─────────────────────────────
-- Body otherwise unchanged from 20260927000000, where its reasoning lives.
create or replace function public.freeze_accepted_terms()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Before anyone has accepted, the owner is still drafting. Terms may change.
  if old.state in ('DRAFTING', 'AWAITING_ACCEPTANCE') then
    return new;
  end if;

  if new.project_name       is distinct from old.project_name
     or new.dod             is distinct from old.dod
     or new.amount_minor    is distinct from old.amount_minor
     or new.amount_jpy      is distinct from old.amount_jpy
     or new.currency        is distinct from old.currency
     or new.deadline        is distinct from old.deadline
     or new.performed_by    is distinct from old.performed_by
     or new.earner_display_name is distinct from old.earner_display_name
  then
    raise exception
      'agreed terms cannot change after acceptance (contract %); record a new agreement instead',
      old.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.freeze_accepted_terms() from public, anon, authenticated;

-- ── 5. Both acceptance functions expose it ──────────────────────────────────
-- `create or replace function` has no other form, so the bodies are restated
-- verbatim from 20260929000000 (invite_acceptance_context) and 20260929000100
-- (accept_invitation) with one key added to each returned `contract` object.
-- The long reasoning for each stays in those files.
--
-- invite_acceptance_context is the hash-critical one: validate-invite-token
-- builds the agreement snapshot from ITS output, not from accept_invitation's,
-- which only feeds the HTTP response.

create or replace function public.invite_acceptance_context(p_invite_token text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  c record;
  v_tip text;
  v_token uuid;
begin
  -- A token that is not a uuid cannot name a row in a uuid column, so it names
  -- no invitation. Reported as not_found rather than raised: the alternative is
  -- a 500 for what is only a malformed link.
  begin
    v_token := p_invite_token::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('status', 'not_found');
  end;

  select ct.*, ct.xmin::text as row_version into c
    from public.contracts ct
   where ct.invite_token = v_token;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if c.invite_token_used_at is not null then
    return jsonb_build_object('status', 'already_used');
  end if;
  if c.invite_token_expires_at is not null and c.invite_token_expires_at < now() then
    return jsonb_build_object('status', 'expired');
  end if;

  -- The chain tip the acceptance event will be linked to. Checked again under
  -- the lock, because another party may append between now and the commit.
  select e.event_hash into v_tip
    from public.events e
   where e.contract_id = c.id::text
     and e.event_hash is not null
   -- id breaks the tie, matching derive_contract_state. created_at comes from
   -- the writer's clock in milliseconds, so two events can share one; without a
   -- tiebreak "the tip" is whichever row the planner happened to return, and
   -- two readers could disagree about where the chain ends.
   order by e.created_at desc, e.id desc
   limit 1;

  return jsonb_build_object(
    'status', 'ok',
    'row_version', c.row_version,
    'chain_tip', v_tip,
    'contract', jsonb_build_object(
      'id',                  c.id,
      'project_name',        c.project_name,
      'dod',                 c.dod,
      'amount_jpy',          c.amount_jpy,
      'amount_minor',        c.amount_minor,
      'currency',            c.currency,
      'deadline',            c.deadline,
      'performed_by',        c.performed_by,
      'earner_display_name', c.earner_display_name,
      'invited_hirer_email', c.invited_hirer_email,
      'state',               c.state
    )
  );
end;
$$;

create or replace function public.accept_invitation(
  p_invite_token        text,
  p_hirer_email         text,
  p_guest_token         text,
  p_guest_token_expires timestamptz,
  p_row_version         text,
  p_prev_event_hash     text,
  p_event               jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  c record;
  v_tip text;
  v_token uuid;
  v_event public.events;
begin
  -- A token that is not a uuid cannot name a row in a uuid column, so it names
  -- no invitation. Reported as not_found rather than raised: the alternative is
  -- a 500 for what is only a malformed link.
  begin
    v_token := p_invite_token::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('status', 'not_found');
  end;

  -- Serializes concurrent accepts of the same invitation.
  select ct.*, ct.xmin::text as row_version into c
    from public.contracts ct
   where ct.invite_token = v_token
     for update;

  -- ── Validation. Nothing has been written yet, so a status is enough. ──
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if c.invite_token_used_at is not null then
    return jsonb_build_object('status', 'already_used');
  end if;
  if c.invite_token_expires_at is not null and c.invite_token_expires_at < now() then
    return jsonb_build_object('status', 'expired');
  end if;

  -- The caller hashed a snapshot of this row. If the row changed in between,
  -- that snapshot describes a deal that is no longer the one on file, and
  -- recording it would attest terms nobody currently holds. xmin is used rather
  -- than a field-by-field comparison so that this check cannot fall out of step
  -- with buildAgreementSnapshot as that grows: any change to the row at all
  -- invalidates the snapshot, which is the conservative direction.
  --
  -- No client can UPDATE contracts — the grants were revoked entirely — so in
  -- practice only another server-side call could trip this. It is defence in
  -- depth, and it is one comparison.
  if c.row_version is distinct from p_row_version then
    return jsonb_build_object('status', 'contract_changed');
  end if;

  -- The chain must still end where the caller believed it did, or the hash
  -- links to the wrong predecessor. The unique index on
  -- (contract_id, prev_event_hash) would catch this too; checking here lets the
  -- caller retry with a fresh tip instead of reading an opaque 23505.
  select e.event_hash into v_tip
    from public.events e
   where e.contract_id = c.id::text
     and e.event_hash is not null
   -- id breaks the tie, matching derive_contract_state. created_at comes from
   -- the writer's clock in milliseconds, so two events can share one; without a
   -- tiebreak "the tip" is whichever row the planner happened to return, and
   -- two readers could disagree about where the chain ends.
   order by e.created_at desc, e.id desc
   limit 1;

  -- An empty chain is SQL NULL here but the literal 'GENESIS' in the caller and
  -- in the row it is about to write, so the two must be brought into one domain
  -- before they are compared. Without this every acceptance fails: the
  -- acceptance event is always the FIRST event on a contract — createContract
  -- writes no event — so v_tip is always null on the real path, `null is
  -- distinct from 'GENESIS'` is true, and the caller's retry loop spins on an
  -- unchanging tip until it gives up with chain_contention.
  --
  -- Both sides are coalesced rather than only one, so this accepts either
  -- convention and the function therefore does not have to be deployed in step
  -- with the Edge Function that calls it. 'GENESIS' cannot collide with a real
  -- tip, which is always a SHA-256 hex digest.
  --
  -- The sentinel belongs here despite living in _shared/eventCanonical.ts: the
  -- partial unique index events_chain_no_fork_idx (… where prev_event_hash is
  -- not null) only guards the genesis link because the first event stores that
  -- literal, so the database's anti-fork guarantee already rests on this value.
  if coalesce(v_tip, 'GENESIS') is distinct from coalesce(p_prev_event_hash, 'GENESIS') then
    return jsonb_build_object('status', 'chain_conflict');
  end if;

  -- ── Commit point. From here, everything lands or nothing does. ──
  --
  -- A raise anywhere below — a unique violation on the fork index, a check
  -- constraint, the freeze trigger — aborts the function and therefore the
  -- statement, and PostgREST runs each call in its own transaction. There is no
  -- ordering of these two writes that can leave one without the other.

  update public.contracts
     set invite_token_used_at          = now(),
         hirer_email                   = p_hirer_email,
         guest_access_token            = p_guest_token::uuid,
         guest_access_token_expires_at = p_guest_token_expires,
         state                         = 'TERMS_ACCEPTED'
   where id = c.id;

  -- Built through jsonb_populate_record rather than a column list with casts.
  -- Each field is converted to whatever type that column actually has, so this
  -- function does not carry a second, hand-maintained copy of the events
  -- schema that could quietly disagree with the table. Keys the table does not
  -- have are ignored; columns the caller did not send stay null, which is what
  -- tsa_token should be.
  insert into public.events
  select *
    from jsonb_populate_record(
      null::public.events,
      p_event || jsonb_build_object('server_recorded_at', now())
    )
  returning * into v_event;

  return jsonb_build_object(
    'status', 'accepted',
    'event', to_jsonb(v_event),
    'contract', jsonb_build_object(
      'id',                  c.id,
      'project_name',        c.project_name,
      'dod',                 c.dod,
      'amount_jpy',          c.amount_jpy,
      'amount_minor',        c.amount_minor,
      'currency',            c.currency,
      'deadline',            c.deadline,
      'performed_by',        c.performed_by,
      'earner_display_name', c.earner_display_name
    )
  );
end;
$$;
-- `create or replace function` keeps the existing privileges, so the EXECUTE
-- grants made when each function was introduced still stand and are not
-- restated here.

-- ── 6. Self-test ────────────────────────────────────────────────────────────
-- Every claim above, asked of the database rather than asserted in a comment.
do $$
declare
  v_id uuid;
  v_ctx jsonb;
begin
  -- The backfill left nothing behind.
  --
  -- Scoped to JPY rather than asked of every row, and the scope is the point:
  -- when this migration runs for the first time JPY is the only currency, so
  -- the two are the same question. After 20261108161000 they are not — a CAD
  -- row has amount_jpy NULL on purpose — and an unscoped assertion would fail
  -- on a legitimate database the moment this file was replayed. Found by
  -- replaying it on E2E after a CAD contract existed.
  if exists (
    select 1 from public.contracts
     where currency = 'JPY' and amount_minor is distinct from amount_jpy
  ) then
    raise exception 'SELF-TEST FAILED: a row where amount_minor and amount_jpy disagree'
      using errcode = 'TF900';
  end if;

  insert into public.contracts (project_name, dod, amount_jpy, amount_minor, currency, state)
  values ('migration self-test', '["self-test"]'::jsonb, 300000, 300000, 'JPY', 'AWAITING_ACCEPTANCE')
  returning id into v_id;

  -- A writer that knows only the old column still lands, with amount_minor
  -- filled from it. This is the case Codex found missing.
  declare v_legacy uuid;
  begin
    insert into public.contracts (project_name, dod, amount_jpy, currency, state)
    values ('migration self-test legacy writer', '["self-test"]'::jsonb, 45000, 'JPY',
            'AWAITING_ACCEPTANCE')
    returning id into v_legacy;
    if (select amount_minor from public.contracts where id = v_legacy) <> 45000 then
      raise exception 'SELF-TEST FAILED: amount_minor was not filled from amount_jpy'
        using errcode = 'TF900';
    end if;
  end;

  -- And a writer that supplies neither still fails, rather than recording a
  -- zero-amount agreement.
  begin
    insert into public.contracts (project_name, dod, currency, state)
    values ('migration self-test', '["self-test"]'::jsonb, 'JPY', 'AWAITING_ACCEPTANCE');
    raise exception 'SELF-TEST FAILED: a contract with no amount at all was accepted'
      using errcode = 'TF900';
  exception
    when not_null_violation then null;
  end;

  -- A row whose two amounts disagree cannot exist.
  begin
    update public.contracts set amount_minor = 3000 where id = v_id;
    raise exception 'SELF-TEST FAILED: amount_minor was allowed to diverge from amount_jpy'
      using errcode = 'TF900';
  exception
    when check_violation then null;
  end;

  -- A zero or negative amount is still refused, now on the new column too.
  begin
    update public.contracts set amount_jpy = 0, amount_minor = 0 where id = v_id;
    raise exception 'SELF-TEST FAILED: a zero amount was accepted'
      using errcode = 'TF900';
  exception
    when check_violation then null;
  end;

  -- The acceptance context carries the new key, which is what the agreement
  -- snapshot is built from.
  update public.contracts set invite_token = gen_random_uuid() where id = v_id;
  select public.invite_acceptance_context(
           (select invite_token::text from public.contracts where id = v_id))
    into v_ctx;
  if v_ctx -> 'contract' -> 'amount_minor' is null then
    raise exception 'SELF-TEST FAILED: invite_acceptance_context does not expose amount_minor'
      using errcode = 'TF900';
  end if;

  -- The freeze trigger now covers it.
  update public.contracts set state = 'TERMS_ACCEPTED' where id = v_id;
  begin
    update public.contracts set amount_minor = 1, amount_jpy = 1 where id = v_id;
    raise exception 'SELF-TEST FAILED: the agreed amount changed after acceptance'
      using errcode = 'TF900';
  exception
    when check_violation then null;
  end;

  raise exception 'self-test complete' using errcode = 'TF901';
exception
  when sqlstate 'TF901' then null;
end $$;

commit;

-- ROLLBACK
--   (restore the two functions from 20260929000000 / 20260929000100 and
--    freeze_accepted_terms from 20260927000000, then)
--   drop trigger contracts_fill_amount_minor on contracts;
--   drop function public.fill_amount_minor_from_legacy();
--   alter table contracts drop constraint contracts_amount_jpy_mirror_check;
--   alter table contracts drop constraint contracts_amount_minor_positive_check;
--   alter table contracts drop column amount_minor;
