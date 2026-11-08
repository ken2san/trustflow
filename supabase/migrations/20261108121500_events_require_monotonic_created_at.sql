-- An event may not be stamped at or before the event it follows.
--
-- THE DEFECT, Codex §4 of the 2026-11-06 review, measured here on 2026-11-08
-- against E2E: two events were written to one contract, the second stamped a
-- minute before the first, and both were accepted.
--
-- `created_at` is assigned Edge-side by `new Date().toISOString()` in
-- `_shared/eventRecord.ts`, it is covered by the event hash, and every reader
-- orders by it: the chain-tip read in `log-event`, the one in
-- `accept_invitation`, `derive_contract_state()`, and the trail both parties
-- are shown. Nothing made it advance. Two isolates whose clocks disagree — or
-- two events in one millisecond, which are then ordered by a random UUID —
-- write a chain whose stamps run backwards. After that the tip read returns
-- the wrong row, `events_chain_no_fork_idx` refuses every later append, and
-- the state that is projected is the one the inverted event names. It cannot
-- be repaired afterwards: the stamp is inside the hash, and the table is
-- append-only.
--
-- WHY HERE AND NOT IN EACH WRITER
-- `log-event` and `reissue-guest-access` check this Edge-side (39ac15a,
-- `createdAtFollows`), one round trip before the insert, which narrows the
-- window without closing it. The acceptance writer did not check it at all —
-- and that commit's message claimed it had no need to, on the grounds that an
-- acceptance is always a chain's first event. It is not: `accept_invitation`
-- reads a chain tip precisely because there may be one, and an owner can write
-- `contract.initiated` on an unaccepted draft, which check 29 of
-- `scripts/api-e2e.mjs` does. The claim was wrong; this is the correction.
--
-- One rule in the one place where it can hold — in the insert's own
-- transaction, under the same lock the parent-existence check takes — covers
-- all three writers and any writer added later. The Edge-side checks stay, as
-- pre-flight: they avoid writing an event that would be refused, and they can
-- retry a tie a round trip later, which is cheaper than a failed insert.
--
-- WHAT IT REFUSES, AND WHAT THAT COSTS
-- Strictly later, so an equal stamp is refused too — that is the
-- same-millisecond tie, and the readers break that tie on a random UUID.
-- The cost, stated plainly because ADA decided it knowingly on 2026-11-07: an
-- isolate whose clock is behind the chain cannot write to that contract until
-- the skew passes. The alternative was clamping the stamp forward to the tip,
-- which was refused: `created_at` would stop meaning the time the server
-- observed the act and start meaning a position in a sequence, permanently and
-- inside the hash. A real per-contract sequence kept beside the observed time
-- is the design Codex recommends and is a larger change than tonight's.
--
-- THE TIP IS max(created_at) OVER ALL EVENTS of the contract, not only hashed
-- ones. The readers that matter here order the whole table, not the subset
-- that carries a hash, so the monotonicity has to hold over the whole table
-- or it does not hold where it is read. E2E has no unhashed and no orphaned
-- events (1957 checked), so the two definitions coincide there today.
--
-- SQLSTATE TF003: distinct from TF001 (wrong state), TF002 (no contract) and
-- 23505 (another event claimed the tip). The callers answer it 409
-- `clock_behind_chain`, after a bounded retry — a tie resolves itself a round
-- trip later, a skew does not.
--
-- EXISTING ROWS ARE LEFT ALONE. Nothing is re-stamped, re-hashed or deleted.
-- A contract whose stamps already run backwards keeps them — and this does not
-- repair it. The first version of this comment said such a contract "can still
-- be appended to, since a fresh stamp is later than anything already there",
-- which is too strong (Codex, 2026-11-08): the tip read selects by
-- (created_at desc, id desc), so on an inverted chain it can keep returning a
-- row that is not the last link, and `events_chain_no_fork_idx` then refuses
-- every append built on it. A chain already inverted can stay un-appendable.
-- What this migration does is stop new ones from being created.
--
-- AND THE ISOLATION LEVEL IT DEPENDS ON. The lock serialises writers, but the
-- `max(created_at)` below is read under the transaction's snapshot, so under
-- REPEATABLE READ it can be a stale answer that the lock cannot refresh. Every
-- writer here runs at READ COMMITTED — PostgREST's default, and the RPCs run
-- inside it — and 20261108134500 makes that a requirement rather than an
-- assumption.

begin;

create or replace function public.enforce_event_created_at_follows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tip timestamptz;
begin
  -- The same row lock the parent-existence trigger takes, so the tip read
  -- below cannot be overtaken between reading it and committing. Without the
  -- lock two concurrent inserts both read the same tip and both pass, which is
  -- the mistake 20261106210207 made first and documented.
  perform 1
  from public.contracts c
  where c.id::text = new.contract_id
  for update;

  select max(e.created_at) into v_tip
  from public.events e
  where e.contract_id = new.contract_id;

  if v_tip is not null and new.created_at <= v_tip then
    raise exception
      'event stamped % does not follow the chain, whose last event is stamped %',
      new.created_at, v_tip
      using errcode = 'TF003',
            hint = 'the writer''s clock is at or behind the chain tip; the stamp is inside the event hash and cannot be corrected later';
  end if;

  return new;
end;
$$;

comment on function public.enforce_event_created_at_follows() is
  'Refuses an event whose created_at is not strictly later than the last event on the same contract, under a lock on the contract row. Keeps the order every reader projects in step with the order the chain was written in.';

drop trigger if exists events_require_monotonic_created_at on public.events;
create trigger events_require_monotonic_created_at
  before insert on public.events
  for each row
  execute function public.enforce_event_created_at_follows();

-- ── The regression test, for the same reason as the previous migration ────
-- The acceptance writer's version of this cannot be driven from outside: a
-- caller cannot make an Edge isolate stamp an event in the past. The rule it
-- now shares with the other writers can be, and is, here — on every database
-- this is applied to, at apply time. Nothing is committed. It does not catch a
-- later redefinition, for the reason given in 20261108121000.
do $$
declare
  v_id uuid;
  v_at timestamptz;
begin
  insert into public.contracts (project_name, dod, amount_jpy, currency, state)
  values ('migration self-test', '["self-test"]'::jsonb, 1, 'JPY', 'TERMS_ACCEPTED')
  returning id into v_id;

  v_at := now();

  insert into public.events (type, contract_id, actor_id, created_at, event_hash)
  values ('contract.initiated', v_id::text, 'migration-self-test', v_at, 'self-test-a');

  -- 1. Stamped before its predecessor: refused.
  begin
    insert into public.events (type, contract_id, actor_id, created_at, event_hash, prev_event_hash)
    values ('agreement.accepted', v_id::text, 'migration-self-test',
            v_at - interval '1 minute', 'self-test-b', 'self-test-a');
    raise exception 'SELF-TEST FAILED: an event stamped before its predecessor was accepted'
      using errcode = 'TF900';
  exception
    when sqlstate 'TF003' then null;
  end;

  -- 2. Stamped at the same instant: refused too. This is the tie that the
  --    readers would otherwise resolve on a random UUID.
  begin
    insert into public.events (type, contract_id, actor_id, created_at, event_hash, prev_event_hash)
    values ('agreement.accepted', v_id::text, 'migration-self-test',
            v_at, 'self-test-c', 'self-test-a');
    raise exception 'SELF-TEST FAILED: an event sharing its predecessor''s stamp was accepted'
      using errcode = 'TF900';
  exception
    when sqlstate 'TF003' then null;
  end;

  -- 3. The control: strictly later is accepted, so the refusals above are
  --    refusals of what they name.
  insert into public.events (type, contract_id, actor_id, created_at, event_hash, prev_event_hash)
  values ('agreement.accepted', v_id::text, 'migration-self-test',
          v_at + interval '1 second', 'self-test-d', 'self-test-a');

  -- Everything above goes back, including the scratch contract. `events` is
  -- append-only, so a rollback is the only way to take a test row back.
  raise exception 'self-test complete' using errcode = 'TF901';
exception
  when sqlstate 'TF901' then null;
end $$;

commit;
