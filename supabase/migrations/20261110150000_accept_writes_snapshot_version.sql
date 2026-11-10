-- Acceptance writes accepted_snapshot_version, in the same transaction.
--
-- WHY
-- 20261109210000 added contracts.accepted_snapshot_version and BACKFILLED it,
-- but nothing wrote it for acceptances made afterwards: accept_invitation set
-- the state, the guest credential and hirer_email, and left the column NULL.
-- Production's first acceptance after that migration (2026-11-10, Task 37) is
-- TERMS_ACCEPTED with a NULL here. NULL means "ask the evidence", so nothing was
-- wrong; the column was only becoming less complete with every acceptance, and
-- a reader built on it would have taken the slow path for every new contract.
--
-- WHAT CHANGES
--   1. The extraction rule the backfill used becomes a permanent function,
--      public.accepted_snapshot_version_of(contract_id). The backfill kept it in
--      pg_temp on purpose, as a one-shot helper; it now has a second caller,
--      and a second copy of a rule is how two copies come to disagree.
--   2. accept_invitation calls it after inserting the acceptance event. The
--      body is restated verbatim from 20261108160000; the ONLY change is the
--      one UPDATE after `returning * into v_event`.
--   3. The backfill is re-run, for rows accepted between 20261109210000 and
--      this migration.
--
-- WHY THE EARLIEST ACCEPTANCE, NOT p_event
-- The obvious version takes the number out of the event being written. It is
-- wrong whenever the contract already holds an acceptance event:
-- events_require_monotonic_created_at makes a new event strictly later than
-- every existing one, so the new acceptance is then not the earliest, and the
-- earliest is what acceptedSnapshotVersion (_shared/eventRecord.ts) reads and
-- what the backfill copied. A column derived from p_event would disagree with
-- the reader it stands in for, exactly on the historical rows where the two
-- most need to agree. Reading the earliest acceptance after the insert gives
-- the same answer as p_event on every normal contract and the right one on the
-- others. The self-test below pins that case.
--
-- WHAT THIS IS NOT
-- No event is rewritten and no hash recomputed. The column is not an agreed
-- term, is not in the agreement snapshot and is hashed into nothing. It is a
-- copy of what the acceptance event already says, and stays NULL where the
-- event says nothing usable.

-- The rule, now in one place. Its body is the pg_temp helper from
-- 20261109210000, unchanged; the reasoning for each clause is there.
create or replace function public.accepted_snapshot_version_of(p_contract_id uuid)
returns integer
language sql
stable
set search_path = ''
as $fn$
  -- Earliest acceptance first, then validate it, in the order
  -- acceptedSnapshotVersion uses: (created_at asc, id asc).
  with earliest as (
    select e.payload -> '_agreement' -> 'snapshot_version' as sv
      from public.events e
     where e.contract_id = p_contract_id::text
       and e.type = 'dod.consent_recorded'
     order by e.created_at asc, e.id asc
     limit 1
  )
  select case
           -- A JSON number, not a string: the runtime refuses the string "1".
           when jsonb_typeof(sv) = 'number'
            -- Integral: 1.5 is not a version.
            and sv::numeric = trunc(sv::numeric)
            -- In range, or the cast to integer aborts the caller.
            and sv::numeric between -2147483648 and 2147483647
           then (sv::numeric)::integer
         end
    from earliest;
$fn$;

-- Same exposure as the function that calls it: the Edge Function's service key
-- only. EXECUTE is granted to PUBLIC by default, and that revoke takes it from
-- service_role too, so it is granted back. accept_invitation is SECURITY
-- INVOKER and runs as service_role, so without this every acceptance would fail.
revoke execute on function public.accepted_snapshot_version_of(uuid) from public, anon, authenticated;
grant execute on function public.accepted_snapshot_version_of(uuid) to service_role;

-- accept_invitation, restated. Everything below down to its closing `$$;` is
-- 20261108160000's body, character for character, plus the one UPDATE that
-- follows the event insert.
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

  -- Which agreement-snapshot version this contract's acceptance bound, copied
  -- onto the row in the same transaction that writes the acceptance
  -- (20261110150000). Read through the same function the backfill uses, so a
  -- live acceptance and a backfilled one cannot be computed two ways. It reads
  -- the EARLIEST acceptance on the contract, not p_event: if an older acceptance
  -- exists, that is the one acceptedSnapshotVersion reads, and the column has to
  -- agree with the reader it stands in for.
  update public.contracts
     set accepted_snapshot_version = public.accepted_snapshot_version_of(c.id)
   where id = c.id;

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

-- `create or replace function` keeps the existing privileges, so
-- accept_invitation's EXECUTE grants from 20260928000000 still stand.

-- The backfill again, for acceptances made between 20261109210000 and now.
-- Same rule, same function; idempotent, and it touches only rows still NULL.
update public.contracts c
   set accepted_snapshot_version = public.accepted_snapshot_version_of(c.id)
 where c.accepted_snapshot_version is null
   and public.accepted_snapshot_version_of(c.id) is not null;

-- ── Self-test ───────────────────────────────────────────────────────────────
-- Same shape as 20261109210000: build fixtures, assert, roll everything back
-- with a sentinel error, because `events` is append-only.
--
-- Unlike that one, this drives accept_invitation itself, because the call site
-- is what changed. A one-shot helper does the part every live case repeats:
-- read the invitation and row version the way validate-invite-token does, and
-- accept it with a given payload.
create function pg_temp.self_test_accept(
  p_contract uuid, p_payload jsonb, p_prev text, p_at timestamptz)
returns jsonb
language plpgsql
as $fn$
declare
  v_token uuid;
  v_row_version text;
begin
  select invite_token, xmin::text into v_token, v_row_version
    from public.contracts where id = p_contract;
  return public.accept_invitation(
    v_token::text, 'self-test@example.test', gen_random_uuid()::text,
    now() + interval '30 days', v_row_version, p_prev,
    jsonb_build_object(
      'id', gen_random_uuid(), 'type', 'dod.consent_recorded',
      'contract_id', p_contract::text, 'actor_id', 'guest:self-test@example.test',
      'created_at', p_at, 'event_hash', 'self-test-' || gen_random_uuid(),
      'prev_event_hash', p_prev, 'payload', p_payload));
end;
$fn$;

do $$
declare
  v_at       timestamptz := now();
  v_contract uuid;
  v_result   jsonb;
  v_got      integer;
begin
  -- The grants: service_role can run the rule, the client roles cannot.
  if not has_function_privilege('service_role', 'public.accepted_snapshot_version_of(uuid)', 'execute')
     or has_function_privilege('anon', 'public.accepted_snapshot_version_of(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.accepted_snapshot_version_of(uuid)', 'execute') then
    raise exception 'SELF-TEST FAILED: accepted_snapshot_version_of has the wrong EXECUTE grants'
      using errcode = 'TF900';
  end if;

  -- ── Live acceptances through accept_invitation ──
  -- {payload, expected}; expected NULL means the column must stay NULL.
  declare
    cases jsonb[] := array[
      '{"_agreement": {"snapshot_version": 1}}'::jsonb,    -- the normal case
      '{"_agreement": {"snapshot_version": "1"}}'::jsonb,  -- the STRING "1"
      '{"_agreement": {"snapshot_version": 2}}'::jsonb,    -- unsupported, kept as recorded
      '{}'::jsonb                                          -- no _agreement
    ];
    expected integer[] := array[1, null, 2, null];
    i int;
  begin
    for i in 1 .. array_length(cases, 1) loop
      insert into public.contracts (project_name, dod, amount_minor, currency)
      values ('self-test live acceptance ' || i, '["self-test"]'::jsonb, 1, 'JPY')
      returning id into v_contract;

      v_result := pg_temp.self_test_accept(v_contract, cases[i], 'GENESIS', v_at);
      if v_result ->> 'status' is distinct from 'accepted' then
        raise exception 'SELF-TEST FAILED: live case % was not accepted: %', i, v_result
          using errcode = 'TF900';
      end if;

      select accepted_snapshot_version into v_got from public.contracts where id = v_contract;
      if v_got is distinct from expected[i] then
        raise exception 'SELF-TEST FAILED: live case % wrote %, expected %',
          i, coalesce(v_got::text, 'NULL'), coalesce(expected[i]::text, 'NULL')
          using errcode = 'TF900';
      end if;
    end loop;
  end;

  -- ── An older acceptance already on the contract ──
  -- The reason this reads the earliest acceptance rather than p_event. The
  -- earliest is malformed and the one being written is valid: the reader
  -- refuses on the earliest, so the column must stay NULL.
  insert into public.contracts (project_name, dod, amount_minor, currency)
  values ('self-test: older acceptance invalid', '["self-test"]'::jsonb, 1, 'JPY')
  returning id into v_contract;
  insert into public.events (type, contract_id, actor_id, created_at, event_hash, payload)
  values ('dod.consent_recorded', v_contract::text, 'migration-self-test',
          v_at, 'self-test-older-a', '{"_agreement": {"snapshot_version": "1"}}'::jsonb);

  v_result := pg_temp.self_test_accept(v_contract, '{"_agreement": {"snapshot_version": 1}}'::jsonb,
                                       'self-test-older-a', v_at + interval '1 second');
  if v_result ->> 'status' is distinct from 'accepted' then
    raise exception 'SELF-TEST FAILED: the older-acceptance case was not accepted: %', v_result
      using errcode = 'TF900';
  end if;
  if (select accepted_snapshot_version from public.contracts where id = v_contract) is not null then
    raise exception 'SELF-TEST FAILED: the acceptance being written overrode an older, invalid one'
      using errcode = 'TF900';
  end if;

  -- And its control, so that NULL is the ordering and not a function that
  -- always returns NULL: older acceptance valid (1), the new one says 2.
  insert into public.contracts (project_name, dod, amount_minor, currency)
  values ('self-test: older acceptance valid', '["self-test"]'::jsonb, 1, 'JPY')
  returning id into v_contract;
  insert into public.events (type, contract_id, actor_id, created_at, event_hash, payload)
  values ('dod.consent_recorded', v_contract::text, 'migration-self-test',
          v_at, 'self-test-older-c', '{"_agreement": {"snapshot_version": 1}}'::jsonb);

  v_result := pg_temp.self_test_accept(v_contract, '{"_agreement": {"snapshot_version": 2}}'::jsonb,
                                       'self-test-older-c', v_at + interval '1 second');
  if (select accepted_snapshot_version from public.contracts where id = v_contract) is distinct from 1 then
    raise exception 'SELF-TEST FAILED: the older valid acceptance was not the one recorded'
      using errcode = 'TF900';
  end if;

  -- ── A refused acceptance writes nothing ──
  -- An already-used invitation returns a status before the commit point, so
  -- the column of the contract it names is untouched.
  v_result := pg_temp.self_test_accept(v_contract, '{"_agreement": {"snapshot_version": 3}}'::jsonb,
                                       'self-test-older-c', v_at + interval '2 seconds');
  if v_result ->> 'status' is distinct from 'already_used'
     or (select accepted_snapshot_version from public.contracts where id = v_contract) is distinct from 1 then
    raise exception 'SELF-TEST FAILED: a refused acceptance changed the column (%)', v_result
      using errcode = 'TF900';
  end if;

  -- ── A draft is untouched ──
  insert into public.contracts (project_name, dod, amount_minor, currency)
  values ('self-test: draft', '["self-test"]'::jsonb, 1, 'JPY')
  returning id into v_contract;
  if public.accepted_snapshot_version_of(v_contract) is not null
     or (select accepted_snapshot_version from public.contracts where id = v_contract) is not null then
    raise exception 'SELF-TEST FAILED: a contract with no acceptance has a version'
      using errcode = 'TF900';
  end if;

  -- ── The permanent function is the backfill's rule ──
  -- The same payload table 20261109210000 asserted against its pg_temp copy,
  -- asked of the copy that now lives on, so the two cannot have diverged.
  declare
    cases jsonb[] := array[
      '{"_agreement": {"snapshot_version": 1}}'::jsonb,
      '{"_agreement": {}}'::jsonb,
      '{"_agreement": {"snapshot_version": "abc"}}'::jsonb,
      '{"_agreement": {"snapshot_version": "1"}}'::jsonb,
      '{"_agreement": {"snapshot_version": 99999999999999999999}}'::jsonb,
      '{"_agreement": {"snapshot_version": 1.5}}'::jsonb,
      '{"_agreement": {"snapshot_version": null}}'::jsonb,
      '{}'::jsonb
    ];
    expected integer[] := array[1, null, null, null, null, null, null, null];
    i int;
  begin
    for i in 1 .. array_length(cases, 1) loop
      insert into public.contracts (project_name, dod, amount_minor, currency, state)
      values ('self-test rule case ' || i, '["self-test"]'::jsonb, 1, 'JPY', 'TERMS_ACCEPTED')
      returning id into v_contract;
      insert into public.events (type, contract_id, actor_id, created_at, event_hash, payload)
      values ('dod.consent_recorded', v_contract::text, 'migration-self-test',
              v_at, 'self-test-rule-' || i, cases[i]);

      v_got := public.accepted_snapshot_version_of(v_contract);
      if v_got is distinct from expected[i] then
        raise exception 'SELF-TEST FAILED: rule case % gave %, expected %',
          i, coalesce(v_got::text, 'NULL'), coalesce(expected[i]::text, 'NULL')
          using errcode = 'TF900';
      end if;
    end loop;
  end;

  -- Tied stamps: the lower id wins. Building a tie needs the monotonic trigger
  -- off, which models the grandfathered rows a tie can still exist in; the
  -- sentinel rollback below puts it back, as in 20261109210000.
  insert into public.contracts (project_name, dod, amount_minor, currency, state)
  values ('self-test: tie, lower id invalid', '["self-test"]'::jsonb, 1, 'JPY', 'TERMS_ACCEPTED')
  returning id into v_contract;
  alter table public.events disable trigger events_require_monotonic_created_at;
  insert into public.events (id, type, contract_id, actor_id, created_at, event_hash, payload)
  values ('00000000-0000-4000-8000-00000000aaaa', 'dod.consent_recorded', v_contract::text,
          'migration-self-test', v_at, 'self-test-tie-a',
          '{"_agreement": {"snapshot_version": "1"}}'::jsonb);
  insert into public.events (id, type, contract_id, actor_id, created_at, event_hash,
                             prev_event_hash, payload)
  values ('00000000-0000-4000-8000-00000000bbbb', 'dod.consent_recorded', v_contract::text,
          'migration-self-test', v_at, 'self-test-tie-b', 'self-test-tie-a',
          '{"_agreement": {"snapshot_version": 1}}'::jsonb);
  alter table public.events enable trigger events_require_monotonic_created_at;
  if public.accepted_snapshot_version_of(v_contract) is not null then
    raise exception 'SELF-TEST FAILED: on tied stamps a higher-id acceptance overrode the lower one'
      using errcode = 'TF900';
  end if;

  raise exception 'self-test complete' using errcode = 'TF901';
exception
  when sqlstate 'TF901' then null;
end $$;

drop function pg_temp.self_test_accept(uuid, jsonb, text, timestamptz);
