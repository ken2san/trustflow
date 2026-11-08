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
-- predicate's subquery included — are not re-evaluated. The same is true of a
-- BEFORE DELETE trigger that only looks: BEFORE triggers run before the heap
-- tuple is locked, so a check made there can be stale by the time the delete
-- actually happens.
--
-- It is also not enough that the projection trigger updates `contracts` for
-- performance events — which would force that re-evaluation — because the
-- event in Codex's own account of this race is `contract.initiated`, and
-- `project_contract_state` leaves the row alone for every non-performance
-- type.
--
-- SO THE DELETE SIDE TAKES THE SAME LOCK FIRST, AND THEN LOOKS.
-- Both sides now serialise on one row and ask their question after holding
-- it. Whichever gets there first wins and the other is refused: the insert
-- finds no contract (TF002), or the delete finds evidence (TF004). There is no
-- interleaving in which both commit, which is the property neither side had
-- alone.
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
  -- Order matters, and it is the whole fix. Taking the lock first means this
  -- waits for any append in flight to commit or roll back, so the question
  -- below is answered against a chain that is no longer moving.
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
-- an argument; these are the two refusals it rests on.
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

  -- 1. A contract that carries evidence is not deletable, by anyone, at any
  --    isolation level, and this runs as the migration role — which bypasses
  --    RLS, so the policy is not what is being tested here.
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
