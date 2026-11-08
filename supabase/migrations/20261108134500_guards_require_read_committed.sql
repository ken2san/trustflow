-- The guards added today hold under READ COMMITTED. This stops that from being
-- an assumption written in a comment.
--
-- WHAT CODEX FOUND, 2026-11-08, reviewing the other three migrations
-- Both of today's arguments — "the delete and the append cannot both commit"
-- and "an event cannot be stamped at or before the chain's last event" — rest
-- on a query inside a trigger seeing a row that another transaction committed
-- while this one waited for the contract's lock. Under READ COMMITTED it does:
-- each query in a plpgsql body takes a fresh snapshot. Under REPEATABLE READ
-- it does not. The transaction's snapshot was established earlier, re-asking
-- returns the same answer however many times it is asked, and because the
-- contract row is only ever LOCKED and never updated, nothing forces a
-- serialization failure either. Both transactions commit, and the guard is
-- silent while it fails.
--
-- Every writer in this system runs at READ COMMITTED: that is PostgREST's
-- default, `log-event` inserts through it, and `accept_invitation`,
-- `reissue_guest_access` and `invite_acceptance_context` run inside such a
-- call. So nothing today is exposed. What was wrong was the shape of the
-- claim — a correctness property that depends on a session setting no part of
-- the system checks.
--
-- SO THE GUARDS CHECK IT, AND REFUSE WHAT THEY CANNOT GUARANTEE.
-- A write at any other isolation level is refused with TF005 rather than
-- accepted under a guarantee that does not hold there. It is a loud failure in
-- a place that has none today, which is the trade this project has taken all
-- week: a refusal that names itself beats a silent hole.
--
-- SERIALIZABLE IS REFUSED TOO, AND THAT IS NOT AN OVERSIGHT. Under SSI the
-- read-write dependency between the DELETE's scan of `events` and the
-- concurrent INSERT would very likely be detected and one transaction aborted
-- — which would make it safe, by a different mechanism. "Very likely" is not a
-- basis for a guarantee about an evidence log, and nothing runs there today,
-- so it is refused rather than assumed. Allowing it is a one-line change for
-- whoever first needs it, with a test to go with it.
--
-- WHY THE THREE FUNCTIONS ARE RESTATED
-- `create or replace function` has no other form. The bodies are otherwise
-- unchanged, and the long reasoning for each stays in the migration that
-- introduced it (20261108121000, 20261108121500, 20261108130000). Those files
-- also had two claims of mine corrected in the same pass — a false statement
-- about when BEFORE DELETE triggers run, and the claim that these guards held
-- at any isolation level — so their text now matches what is deployed here.

begin;

create or replace function public.require_read_committed(p_what text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_level text := pg_catalog.current_setting('transaction_isolation');
begin
  -- 'read uncommitted' is accepted because PostgreSQL implements it as READ
  -- COMMITTED; it is the same behaviour under a different name, not a weaker
  -- promise that happens to be tolerated.
  if v_level not in ('read committed', 'read uncommitted') then
    raise exception
      '% is only guaranteed under READ COMMITTED; this transaction is %', p_what, v_level
      using errcode = 'TF005',
            hint = 'the guard re-reads under a fresh snapshot after taking the contract lock, which a REPEATABLE READ or SERIALIZABLE snapshot does not allow';
  end if;
end;
$$;

comment on function public.require_read_committed(text) is
  'Refuses a write whose guard depends on a fresh snapshot taken after a lock, when the transaction''s isolation level would not provide one.';

-- ── The three guards, unchanged but for the precondition ──────────────────

create or replace function public.enforce_event_parent_contract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_read_committed('appending evidence');

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

create or replace function public.enforce_event_created_at_follows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tip timestamptz;
begin
  perform public.require_read_committed('appending evidence');

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

create or replace function public.refuse_delete_of_contract_with_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_read_committed('deleting an agreement');

  -- Redundant on the ordinary DELETE path — the row is already locked by the
  -- time a BEFORE DELETE trigger runs (PostgreSQL 17, `GetTupleForTrigger`
  -- with LockTupleExclusive) — and kept deliberately: the property this guard
  -- rests on is "ask only while holding the row", and stating it here makes
  -- that independent of when the executor happens to take the lock.
  perform 1
  from public.contracts c
  where c.id = old.id
  for update;

  -- The re-check is the fix, not the lock. Each query in a plpgsql body takes
  -- a fresh snapshot under READ COMMITTED, so this sees an append that
  -- committed while the delete waited — which the RLS predicate, evaluated
  -- once during the scan, cannot do.
  if exists (select 1 from public.events e where e.contract_id = old.id::text) then
    raise exception
      'contract % carries evidence and cannot be deleted', old.id
      using errcode = 'TF004',
            hint = 'evidence was appended while this delete was in flight; the agreement is now part of the record';
  end if;

  return old;
end;
$$;

-- ── Self-test, committing nothing ─────────────────────────────────────────
-- The precondition cannot be tested from inside this transaction: SET
-- TRANSACTION ISOLATION LEVEL has to come before any query, and this one has
-- run plenty. What is tested is that the three guards still refuse what they
-- refused, and still accept what they accepted, now that they call it — i.e.
-- that the precondition did not quietly become the only thing they do. The
-- isolation refusal itself was measured from a separate session; the result is
-- in .ada/claude-report-2.md.
do $$
declare
  v_id uuid;
  v_at timestamptz;
begin
  -- TF002 still fires.
  begin
    insert into public.events (type, contract_id, actor_id)
    values ('contract.initiated', gen_random_uuid()::text, 'migration-self-test');
    raise exception 'SELF-TEST FAILED: an event with no contract was accepted'
      using errcode = 'TF900';
  exception
    when sqlstate 'TF002' then null;
  end;

  insert into public.contracts (project_name, dod, amount_jpy, currency, state)
  values ('migration self-test', '["self-test"]'::jsonb, 1, 'JPY', 'AWAITING_ACCEPTANCE')
  returning id into v_id;

  v_at := now();
  insert into public.events (type, contract_id, actor_id, created_at, event_hash)
  values ('contract.initiated', v_id::text, 'migration-self-test', v_at, 'self-test-a');

  -- TF003 still fires.
  begin
    insert into public.events (type, contract_id, actor_id, created_at, event_hash, prev_event_hash)
    values ('agreement.accepted', v_id::text, 'migration-self-test',
            v_at, 'self-test-b', 'self-test-a');
    raise exception 'SELF-TEST FAILED: an event sharing its predecessor''s stamp was accepted'
      using errcode = 'TF900';
  exception
    when sqlstate 'TF003' then null;
  end;

  -- The control: a later stamp still lands.
  insert into public.events (type, contract_id, actor_id, created_at, event_hash, prev_event_hash)
  values ('agreement.accepted', v_id::text, 'migration-self-test',
          v_at + interval '1 second', 'self-test-c', 'self-test-a');

  -- TF004 still fires.
  begin
    delete from public.contracts where id = v_id;
    raise exception 'SELF-TEST FAILED: a contract carrying evidence was deleted'
      using errcode = 'TF900';
  exception
    when sqlstate 'TF004' then null;
  end;

  raise exception 'self-test complete' using errcode = 'TF901';
exception
  when sqlstate 'TF901' then null;
end $$;

commit;
