-- Six currencies become legal, and amount_jpy stops pretending to hold them.
--
-- STEP 3 OF 3. 20261108160000 added `amount_minor` and filled it; the Edge
-- Functions were then deployed so that every reader asks for it. Only now is a
-- non-JPY contract representable. Applying this file before that deploy would
-- let a CAD contract be created while a function still reading `amount_jpy`
-- would see NULL and hash an agreement snapshot with no amount in it.
--
-- THE LIST
-- JPY, CAD, HKD, USD, EUR, GBP — ISO 4217, the same six as
-- supabase/functions/_shared/money.ts, which is the source of truth the
-- frontend and the Edge Functions share. This is the database's hand-kept copy
-- of it, which is why both places say so in a comment. Adding a seventh is an
-- append here and a line there. Removing one is not available: it would
-- retroactively make existing agreements unrepresentable.
--
-- NO FX. Nothing in this database converts between these, and there is no
-- column to hold a rate. An amount is only ever read next to its own currency.
--
-- WHY amount_jpy BECOMES NULL RATHER THAN A COPY
-- The alternative was to keep it equal to amount_minor for every currency.
-- That stores 1250 in a column called amount_jpy for a CA$12.50 contract — a
-- number that is factually wrong in the unit its own name states, and wrong by
-- a factor of 100 for anything that trusts the name. NULL cannot be
-- misread: a reader that still asks for the old column gets no amount rather
-- than a plausible wrong one, which is the direction an evidence system should
-- fail. For JPY the mirror is kept, so every row that exists today is
-- untouched and continues to read back identically.
--
-- amount_jpy therefore loses NOT NULL. Nothing in the application writes it
-- for a non-JPY contract, and the CHECK below makes the inconsistent
-- combinations unrepresentable in both directions.

begin;

-- ── 1. The allowed currencies ───────────────────────────────────────────────
alter table contracts drop constraint if exists contracts_currency_check;
alter table contracts
  add constraint contracts_currency_check
  check (currency in ('JPY', 'CAD', 'HKD', 'USD', 'EUR', 'GBP'));

-- ── 2. amount_jpy: a JPY mirror, or nothing ─────────────────────────────────
alter table contracts alter column amount_jpy drop not null;

-- Its DEFAULT 0 was dropped in 20261108160000 and is not repeated here.
--
-- It was found by this file's own self-test on E2E — the first CAD insert was
-- refused by the mirror CHECK because a row supplying no amount_jpy was still
-- getting 0 from the column default rather than NULL — and then MOVED to the
-- previous migration, because the fill trigger there depends on it: with the
-- default alive, "no amount at all" arrives as 0 and fails the positivity
-- CHECK rather than NOT NULL. A deprecated column that silently fills itself
-- with a plausible number is exactly the trap the NULL was chosen to avoid.

alter table contracts drop constraint if exists contracts_amount_positive_check;
-- Replaced by contracts_amount_minor_positive_check (20261108160000). The old
-- one read `amount_jpy > 0`, which a NULL would pass silently anyway; the
-- positivity rule now lives on the column that always holds a value.

alter table contracts drop constraint if exists contracts_amount_jpy_mirror_check;
alter table contracts
  add constraint contracts_amount_jpy_mirror_check
  check (
    case currency
      -- `is not null` is not redundant. A CHECK passes on NULL — the
      -- comparison evaluates to unknown, not false — so `amount_jpy =
      -- amount_minor` alone accepted a JPY row that supplied no amount_jpy at
      -- all, which is the opposite of what this constraint is for. Found by
      -- this file's own self-test on E2E, which is the second thing it caught
      -- that reading the SQL had not.
      when 'JPY' then amount_jpy is not null and amount_jpy = amount_minor
      else amount_jpy is null
    end
  );

-- ── 3. Self-test ────────────────────────────────────────────────────────────
do $$
declare
  v_id uuid;
begin
  -- A CAD contract in cents, which was impossible one statement ago.
  insert into public.contracts (project_name, dod, amount_minor, currency, state)
  values ('migration self-test', '["self-test"]'::jsonb, 1250, 'CAD', 'AWAITING_ACCEPTANCE')
  returning id into v_id;

  -- A currency nobody has agreed to is still refused.
  begin
    insert into public.contracts (project_name, dod, amount_minor, currency, state)
    values ('migration self-test', '["self-test"]'::jsonb, 1250, 'ZZZ', 'AWAITING_ACCEPTANCE');
    raise exception 'SELF-TEST FAILED: currency ZZZ was accepted'
      using errcode = 'TF900';
  exception
    when check_violation then null;
  end;

  -- A non-JPY row may not carry an amount_jpy, whatever value it is.
  begin
    insert into public.contracts (project_name, dod, amount_minor, amount_jpy, currency, state)
    values ('migration self-test', '["self-test"]'::jsonb, 1250, 1250, 'CAD', 'AWAITING_ACCEPTANCE');
    raise exception 'SELF-TEST FAILED: a CAD row was allowed to carry amount_jpy'
      using errcode = 'TF900';
  exception
    when check_violation then null;
  end;

  -- A JPY row must still carry the mirror, and must still agree with it.
  begin
    insert into public.contracts (project_name, dod, amount_minor, currency, state)
    values ('migration self-test', '["self-test"]'::jsonb, 300000, 'JPY', 'AWAITING_ACCEPTANCE');
    raise exception 'SELF-TEST FAILED: a JPY row with no amount_jpy was accepted'
      using errcode = 'TF900';
  exception
    when check_violation then null;
  end;

  -- Every row that existed before this migration still satisfies the new rule.
  if exists (
    select 1 from public.contracts
     where currency = 'JPY' and amount_jpy is distinct from amount_minor
  ) then
    raise exception 'SELF-TEST FAILED: an existing JPY row no longer mirrors'
      using errcode = 'TF900';
  end if;

  raise exception 'self-test complete' using errcode = 'TF901';
exception
  when sqlstate 'TF901' then null;
end $$;

commit;

-- ROLLBACK
--   -- only while no non-JPY row exists; a CAD contract cannot be expressed
--   -- under the old constraint and would have to be deleted first.
--   alter table contracts drop constraint contracts_amount_jpy_mirror_check;
--   alter table contracts add constraint contracts_amount_jpy_mirror_check
--     check (amount_jpy = amount_minor);
--   alter table contracts alter column amount_jpy set not null;
--   alter table contracts drop constraint contracts_currency_check;
--   alter table contracts add constraint contracts_currency_check check (currency = 'JPY');
