-- Evidence may not be appended to an agreement that no longer exists.
--
-- THE DEFECT, as Codex named it on 2026-11-06 (§2 of its transaction-boundary
-- review) and as measured here against E2E on 2026-11-08:
--
--   do $$ begin
--     insert into public.events (type, contract_id, actor_id)
--     values ('contract.initiated', gen_random_uuid()::text, 'guard-probe');
--   ...
--   PROBE: an event whose contract does not exist was accepted
--
-- `log-event` reads the contract, authorises the caller, and then inserts in a
-- separate statement. Between those two the owner may legally DELETE the
-- contract: `owner_delete_unaccepted_draft` (20261104204009) permits it while
-- the draft is unaccepted and carries no evidence, and at that moment it
-- carries none, because the insert has not landed yet. The insert then lands
-- against an absent parent. `events.contract_id` is text with no foreign key —
-- deliberately, it holds pre-migration ids — so nothing refused it.
--
-- The previous session verified the DELETE side of that race and reported the
-- defect closed. The DELETE side is not where it happens. The write side had
-- no guard at all, and the 2026-11-06 ordering trigger made that explicit:
--
--   -- No contract: leave it to whatever else governs that.
--   if current_state is null then return new; end if;
--
-- There was no "whatever else". That is fail-open, by its own comment, and it
-- is corrected below along with the general case.
--
-- WHAT CLOSES IT
-- Every insert into `events` now locks its parent contract row and refuses if
-- there is none. The lock is the half that matters: all evidence writers and
-- the DELETE serialise on the same row, so the delete either commits first —
-- and this insert then finds nothing and is refused — or waits, and finds the
-- evidence that makes it refuse. Under READ COMMITTED — which is what every
-- writer here runs at, PostgREST and the RPCs alike — no interleaving is left
-- in which both succeed. The scope of that claim is not decoration: see
-- 20261108130000, where the same argument is stated in full together with the
-- isolation level it depends on.
--
-- WHY NOT A FOREIGN KEY, which is the obvious answer
-- `contract_id` is text and holds values that are not uuids at all ('1',
-- 'mock', 'runtime') from the pre-migration demo flow; see the column's own
-- comment in 20260313000000. A foreign key needs a type change and a decision
-- about those rows, which is a data migration, not this. (E2E holds 1957
-- events, none of them non-uuid and none orphaned, checked today — so the
-- cleanup is probably small. It is still not tonight's, and not mine.)
--
-- SQLSTATE TF002, so `log-event` can answer 409 rather than 500 and so it is
-- never confused with TF001 (wrong state) or 23505 (another event claimed the
-- tip, which is retried). A refusal that reads as a server fault teaches the
-- caller to retry something that cannot succeed.

begin;

create or replace function public.enforce_event_parent_contract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- `for update` and not a bare existence check: the point is to serialise
  -- with the DELETE and with every other writer of this chain, not to ask a
  -- question whose answer can change before the row lands.
  perform 1
  from public.contracts c
  where c.id::text = new.contract_id
  for update;

  if not found then
    raise exception
      'contract % does not exist; evidence cannot be appended to it', new.contract_id
      using errcode = 'TF002',
            hint = 'the agreement was deleted while this write was in flight';
  end if;

  return new;
end;
$$;

comment on function public.enforce_event_parent_contract() is
  'Refuses an event whose contract row is absent, under a lock on that row, so that a concurrent DELETE and an in-flight append cannot both succeed.';

drop trigger if exists events_require_live_contract on public.events;
create trigger events_require_live_contract
  before insert on public.events
  for each row
  execute function public.enforce_event_parent_contract();

-- The same hole, in the trigger added for ordering two days ago. Only the
-- fail-open branch changes; the rest is 20261106210207 verbatim, which is why
-- the whole function is restated rather than patched — `create or replace`
-- has no other form.
create or replace function public.enforce_performance_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_state text;
begin
  -- Only the performance flow. See 20261106210207 for the scope note.
  if new.type not in ('performance.asserted', 'performance.accepted', 'performance.rejected') then
    return new;
  end if;

  select c.state into current_state
  from public.contracts c
  where c.id::text = new.contract_id
  for update;

  -- WAS: `if current_state is null then return new; end if;` — an event for a
  -- contract that is not there was waved through. `contracts.state` is NOT
  -- NULL with a default (20260527000000), so a null here means no row, and
  -- nothing else. Both triggers answer it the same way; neither relies on the
  -- other firing first, because trigger order is alphabetical and that is a
  -- poor thing for a guarantee to rest on.
  if current_state is null then
    raise exception
      'contract % does not exist; evidence cannot be appended to it', new.contract_id
      using errcode = 'TF002',
            hint = 'the agreement was deleted while this write was in flight';
  end if;

  if not (
    (current_state = 'TERMS_ACCEPTED'        and new.type = 'performance.asserted')
    or (current_state = 'AWAITING_CONFIRMATION' and new.type in ('performance.accepted', 'performance.rejected'))
  ) then
    raise exception
      'event % is not permitted while the agreement is in state %', new.type, current_state
      using errcode = 'TF001',
            hint = 'performance.asserted follows TERMS_ACCEPTED; accepted and rejected follow AWAITING_CONFIRMATION';
  end if;

  return new;
end;
$$;

-- ── The regression test, run here because here is where it can run ─────────
--
-- The race needs an append held open while a DELETE commits, which no caller
-- can arrange from outside: `scripts/api-e2e.mjs` has no service role and no
-- test-only hook, on purpose. What it can test is the write boundary itself,
-- which is where the refusal has to happen, and it runs on every database this
-- migration is ever applied to.
--
-- What it is NOT, said here because the first version of this comment claimed
-- it (Codex, 2026-11-08): it does not catch a future redefinition. A DO block
-- runs once, at apply, and a later migration that breaks this function does
-- not re-run it. Only a rebuild from an empty database would. So this guards
-- the apply, not the next person's edit.
--
-- Nothing is committed. Each case is a sub-block whose own raise discards it,
-- which is also how the rows below are cleaned up: `events` is append-only
-- (DO INSTEAD NOTHING on UPDATE and DELETE), so a rollback is the only way to
-- take a test row back.
do $$
declare
  v_id uuid;
begin
  -- 1. An absent parent is refused, with TF002.
  begin
    insert into public.events (type, contract_id, actor_id)
    values ('contract.initiated', gen_random_uuid()::text, 'migration-self-test');
    raise exception 'SELF-TEST FAILED: an event with no contract was accepted'
      using errcode = 'TF900';
  exception
    when sqlstate 'TF002' then null;
  end;

  -- 2. A performance event with an absent parent is refused too — the branch
  --    that used to return NEW.
  begin
    insert into public.events (type, contract_id, actor_id)
    values ('performance.asserted', gen_random_uuid()::text, 'migration-self-test');
    raise exception 'SELF-TEST FAILED: a performance event with no contract was accepted'
      using errcode = 'TF900';
  exception
    when sqlstate 'TF002' then null;
  end;

  -- 3. The control. A live parent still accepts an event, so the two cases
  --    above are refusals of what they name and not of everything.
  begin
    insert into public.contracts (project_name, dod, amount_jpy, currency, state)
    values ('migration self-test', '["self-test"]'::jsonb, 1, 'JPY', 'TERMS_ACCEPTED')
    returning id into v_id;

    insert into public.events (type, contract_id, actor_id)
    values ('contract.initiated', v_id::text, 'migration-self-test');

    -- Expected, and the only way back out: everything in this sub-block goes.
    raise exception 'self-test complete' using errcode = 'TF901';
  exception
    when sqlstate 'TF901' then null;
  end;
end $$;

commit;
