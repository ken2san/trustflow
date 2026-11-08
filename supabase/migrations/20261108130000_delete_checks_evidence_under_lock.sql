-- The other half of the same race, which the write-side lock does not close.
--
-- 20261108121000 made every event writer lock its parent contract and refuse
-- if it is gone. That closes "DELETE commits, then the insert lands". It does
-- not close the reverse order, and the reverse order is reachable:
--
--   1. The owner's DELETE is planned. `owner_delete_unaccepted_draft`
--      (20261104204009) checks `not exists (select 1 from events …)` as part
--      of the scan, under the statement's snapshot: no evidence yet.
--   2. log-event's insert commits. It took the contract row's lock, checked
--      the parent, wrote the event, and released.
--   3. The DELETE proceeds to remove the row.
--
-- Nothing re-asks the question in step 3. A row-level `for update` lock is
-- recorded in the tuple header without creating a new row version, so the
-- waiting DELETE does not see the tuple as modified, and the quals — the RLS
-- predicate's subquery included — are not re-evaluated.
--
-- A CORRECTION TO THIS FILE'S FIRST VERSION, which said that a BEFORE DELETE
-- trigger runs before the heap tuple is locked and that taking the lock inside
-- the trigger was therefore the fix. That is false. In PostgreSQL 17
-- `ExecBRDeleteTriggersNew()` locks the row with `GetTupleForTrigger(…
-- LockTupleExclusive …)` and only then calls the user trigger (`trigger.c`),
-- so on the ordinary heap DELETE path the explicit `for update` below is
-- redundant. Codex found this, 2026-11-08, against the Postgres source rather
-- than against my reasoning about it.
--
-- The fix is still a trigger, for the other half of the reason: what the RLS
-- predicate cannot do is ask again AFTER the lock. A plpgsql trigger body is
-- VOLATILE and each query inside it takes a fresh snapshot under READ
-- COMMITTED, so the `exists` below sees an append that committed while this
-- delete waited. That re-check is the fix; the lock was already held.
--
-- It is also not enough that the projection trigger updates `contracts` for
-- performance events — which would force that re-evaluation — because the
-- event in Codex's own account of this race is `contract.initiated`, and
-- `project_contract_state` leaves the row alone for every non-performance
-- type.
--
-- SO THE DELETE SIDE LOOKS AGAIN, UNDER THE LOCK.
-- Both sides now ask their question while holding the contract row. Whichever
-- gets there first wins and the other is refused: the insert finds no contract
-- (TF002), or the delete finds evidence (TF004). Neither side had that
-- property alone.
--
-- IT HOLDS UNDER READ COMMITTED, AND THE CLAIM STOPS THERE.
-- Under REPEATABLE READ it does not: a DELETE whose snapshot was established
-- before a concurrent append sees no evidence however many times it asks, and
-- because the contract row is only locked and never updated, nothing forces a
-- serialization failure either. Both would commit. Every writer in this system
-- runs at READ COMMITTED — PostgREST's default, and the three RPCs run inside
-- it — so the guarantee covers what actually happens; it is an assumption all
-- the same, and 20261108134500 turns it into a checked precondition rather
-- than leaving it in a comment. (Codex, 2026-11-08: the first version of this
-- file claimed the refusal held "at any isolation level". It does not.)
--
-- WHY A TRIGGER AND NOT A STRICTER POLICY
-- An RLS predicate is a qual on a scan; it cannot take a lock and it is
-- evaluated when the scan runs. The policy stays — it is what makes the
-- ordinary refusal silent and cheap, with no row matched — and this is the
-- guard for the case where the answer changes under the caller. The trigger
-- also holds for `service_role`, which bypasses RLS entirely and therefore
-- bypasses that policy; nothing deletes contracts that way today, and this
-- means nothing has to remember not to.
--
-- SQLSTATE TF004. No client reaches it on the ordinary path, because the
-- policy has already rowed the contract out of scope; it is specifically the
-- race's answer.

begin;

create or replace function public.refuse_delete_of_contract_with_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Redundant on the ordinary DELETE path — the row is already locked by the
  -- time a BEFORE DELETE trigger runs — and kept deliberately: the property
  -- this guard rests on is "ask only while holding the row", and stating it
  -- here makes that independent of when the executor happens to take the lock.
  -- Harmless either way; it is the same lock in the same transaction.
  perform 1
  from public.contracts c
  where c.id = old.id
  for update;

  if exists (select 1 from public.events e where e.contract_id = old.id::text) then
    raise exception
      'contract % carries evidence and cannot be deleted', old.id
      using errcode = 'TF004',
            hint = 'evidence was appended while this delete was in flight; the agreement is now part of the record';
  end if;

  return old;
end;
$$;

comment on function public.refuse_delete_of_contract_with_evidence() is
  'Refuses to delete a contract that has events, re-checked under a lock on the contract row so that an append committing mid-delete cannot be orphaned. Complements owner_delete_unaccepted_draft, which cannot lock.';

drop trigger if exists contracts_refuse_delete_with_evidence on public.contracts;
create trigger contracts_refuse_delete_with_evidence
  before delete on public.contracts
  for each row
  execute function public.refuse_delete_of_contract_with_evidence();

-- ── Regression test, run at apply time, committing nothing ────────────────
-- The interleaving itself still cannot be driven from here — it needs two
-- sessions — so what is tested is each side's refusal and, as the control,
-- that an empty draft is still deletable. The serialisation argument above is
-- an argument; these are the two refusals it rests on. And a DO block runs
-- once, at apply: it does not catch a later redefinition.
do $$
declare
  v_with_evidence uuid;
  v_empty uuid;
begin
  insert into public.contracts (project_name, dod, amount_jpy, currency, state)
  values ('migration self-test', '["self-test"]'::jsonb, 1, 'JPY', 'AWAITING_ACCEPTANCE')
  returning id into v_with_evidence;

  insert into public.events (type, contract_id, actor_id)
  values ('contract.initiated', v_with_evidence::text, 'migration-self-test');

  -- 1. A contract that carries evidence is not deletable, by anyone — this
  --    runs as the migration role, which bypasses RLS, so the policy is not
  --    what is being tested here. Not "at any isolation level", which is what
  --    this comment said first: under READ COMMITTED, which is this
  --    transaction's level and every writer's.
  begin
    delete from public.contracts where id = v_with_evidence;
    raise exception 'SELF-TEST FAILED: a contract carrying evidence was deleted'
      using errcode = 'TF900';
  exception
    when sqlstate 'TF004' then null;
  end;

  -- 2. The control. An empty draft is still deletable, so case 1 is a refusal
  --    of what it names and this migration has not simply broken deletion.
  insert into public.contracts (project_name, dod, amount_jpy, currency, state)
  values ('migration self-test', '["self-test"]'::jsonb, 1, 'JPY', 'AWAITING_ACCEPTANCE')
  returning id into v_empty;

  delete from public.contracts where id = v_empty;
  if exists (select 1 from public.contracts where id = v_empty) then
    raise exception 'SELF-TEST FAILED: an empty draft could not be deleted'
      using errcode = 'TF900';
  end if;

  raise exception 'self-test complete' using errcode = 'TF901';
exception
  when sqlstate 'TF901' then null;
end $$;

commit;
