-- Stage A tests for public.create_entry_contract. Run only on a disposable local
-- database with the migration applied (tests/sql/create_entry_contract.sh).
-- Every check raises on failure; the transaction is rolled back at the end.
begin;
insert into auth.users (id,email,is_anonymous,email_confirmed_at) values
  ('11111111-1111-4111-8111-111111111111','owner-c5@example.test',false,clock_timestamp()),
  ('22222222-2222-4222-8222-222222222222','other-c5@example.test',false,clock_timestamp()),
  ('33333333-3333-4333-8333-333333333333','unconfirmed-c5@example.test',false,null),
  ('44444444-4444-4444-8444-444444444444',null,true,null);
insert into public.contracts (id,earner_user_id,project_name,dod,amount_minor,invited_hirer_email) values
  ('99999999-9999-4999-8999-999999999999','22222222-2222-4222-8222-222222222222','other user deal','["x"]',5,'x@example.test');

-- Row count that RLS cannot hide: a count taken as `authenticated` sees only
-- the caller's own rows, so "no row was left" would pass vacuously.
create function pg_temp.total() returns bigint language sql security definer set search_path = ''
  as 'select count(*) from public.contracts';
grant execute on function pg_temp.total() to authenticated;

-- NULL-safe check of a created response: returns NULL when every assertion
-- holds, otherwise the first failed one. Every comparison is IS DISTINCT FROM
-- or an explicit null test, so a missing or NULL value cannot pass.
create function pg_temp.check_created(res jsonb, owner uuid) returns text language plpgsql as $f$
declare c jsonb := res->'contract'; cols text[];
begin
  if res is null then return 'null response'; end if;
  if res->>'status' is distinct from 'created' then return 'status'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(res) k) is distinct from array['contract','status'] then return 'top-level keys'; end if;
  if jsonb_typeof(c) is distinct from 'object' then return 'contract not an object'; end if;
  select array_agg(attname::text order by attname) into cols from pg_attribute where attrelid = 'public.contracts'::regclass and attnum > 0 and not attisdropped;
  if (select array_agg(k order by k) from jsonb_object_keys(c) k) is distinct from cols then return 'contract keys'; end if;
  if exists (select 1 from unnest(cols) x where not has_column_privilege('authenticated','public.contracts',x,'SELECT')) then return 'unselectable column returned'; end if;
  if c->>'id' is null then return 'id'; end if;
  if c->>'earner_user_id' is distinct from owner::text then return 'owner'; end if;
  if c->>'state' is distinct from 'AWAITING_ACCEPTANCE' then return 'state'; end if;
  if c->>'invite_token' is null then return 'invite_token'; end if;
  if c->>'created_at' is null or c->>'invite_token_expires_at' is null then return 'timestamps'; end if;
  if (abs(extract(epoch from ((c->>'invite_token_expires_at')::timestamptz - (c->>'created_at')::timestamptz)) - 72*3600) <= 5) is not true then return 'invite ttl'; end if;
  if c->>'invite_token_used_at' is not null or c->>'hirer_user_id' is not null or c->>'hirer_email' is not null
     or c->>'guest_access_token' is not null or c->>'counterpart_account_id' is not null or c->>'dod_hash' is not null
     or c->>'accepted_snapshot_version' is not null then return 'protected fields'; end if;
  return null;
end $f$;
grant execute on function pg_temp.check_created(jsonb, uuid) to authenticated;

-- Privileges and owner.
do $$
declare f regprocedure := 'public.create_entry_contract(text,jsonb,integer,text,date,text,text,text)';
begin
  if has_function_privilege('anon',f,'EXECUTE') or has_function_privilege('public',f,'EXECUTE') then raise exception 'FAIL anon/PUBLIC may execute'; end if;
  if not has_function_privilege('authenticated',f,'EXECUTE') then raise exception 'FAIL authenticated cannot execute'; end if;
  if not has_any_column_privilege((select pg_get_userbyid(proowner) from pg_proc where oid=f),'auth.users','UPDATE') then raise exception 'FAIL definer owner cannot lock auth.users'; end if;
  raise notice 'PASS privileges (anon/PUBLIC no EXECUTE, authenticated EXECUTE, owner holds auth.users UPDATE)';
end $$;

set local role anon;
do $$ begin
  perform public.create_entry_contract('p','["a"]',1,'JPY',null,'g@example.test','creator',null);
  raise exception 'FAIL anon executed';
exception when insufficient_privilege then raise notice 'PASS anon refused (insufficient_privilege)'; end $$;
reset role;

set local role authenticated;
create temp table r (k text, v jsonb) on commit drop;
-- Callers that must be refused.
do $$
declare res jsonb; who text; n0 bigint; n1 bigint;
begin
  n0 := pg_temp.total();
  foreach who in array array['', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'] loop
    perform set_config('request.jwt.claim.sub', who, true);
    res := public.create_entry_contract('p','["a"]',1,'JPY',null,'g@example.test','creator',null);
    if res is distinct from '{"status":"not_authorized"}'::jsonb then raise exception 'FAIL caller % got %', who, res; end if;
  end loop;
  n1 := pg_temp.total();
  if n1 is distinct from n0 then raise exception 'FAIL refused callers left rows'; end if;
  raise notice 'PASS no sub / unconfirmed / anonymous / unknown user refused, no row';
end $$;

-- Owner create.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
insert into r select 'ok', public.create_entry_contract('Probe','["a","b"]',1000,'JPY','2099-01-01','G@Example.test','counterparty','Owner Name');
do $$
declare res jsonb := (select v from r where k='ok'); c jsonb := res->'contract'; why text; m jsonb; n int := 0;
  owner uuid := '11111111-1111-4111-8111-111111111111';
begin
  why := pg_temp.check_created(res, owner);
  if why is not null then raise exception 'FAIL owner create: % in %', why, res; end if;
  if c->'dod' is distinct from '["a","b"]'::jsonb or c->>'project_name' is distinct from 'Probe'
     or c->>'amount_minor' is distinct from '1000' or c->>'amount_jpy' is distinct from '1000' or c->>'currency' is distinct from 'JPY'
     or c->>'deadline' is distinct from '2099-01-01' or c->>'invited_hirer_email' is distinct from 'G@Example.test'
     or c->>'performed_by' is distinct from 'counterparty' or c->>'earner_display_name' is distinct from 'Owner Name' then
    raise exception 'FAIL stored terms differ from inputs %', c; end if;
  if res::text like '%99999999-9999-4999-8999-999999999999%' or res::text like '%other-c5%' or res::text like '%22222222-2222%' then raise exception 'FAIL other user data disclosed'; end if;
  if not exists (select 1 from public.contracts where id = (c->>'id')::uuid and earner_user_id = owner) then raise exception 'FAIL row not visible to owner'; end if;
  raise notice 'PASS owner create: owner=auth.uid(), exact shape, terms unrewritten, server-derived fields, 72h invite, no other-user data';
  -- Negative controls: each mutation of the real response must be rejected.
  foreach m in array array[
    null::jsonb, res - 'status', jsonb_set(res, '{status}', 'null'), jsonb_set(res, '{status}', '"invalid_terms"'),
    res || '{"extra":1}', jsonb_set(res, '{contract}', '{}'), res - 'contract',
    jsonb_set(res, '{contract,earner_user_id}', 'null'), res #- '{contract,earner_user_id}',
    jsonb_set(res, '{contract,earner_user_id}', '"22222222-2222-4222-8222-222222222222"'),
    jsonb_set(res, '{contract,id}', 'null'), jsonb_set(res, '{contract,state}', 'null'),
    jsonb_set(res, '{contract,created_at}', 'null'), jsonb_set(res, '{contract,invite_token_expires_at}', 'null'),
    jsonb_set(res, '{contract,invite_token_expires_at}', to_jsonb(((c->>'created_at')::timestamptz + interval '1 hour')::text)),
    jsonb_set(res, '{contract,invite_token}', 'null'), jsonb_set(res, '{contract,dod_hash}', '"x"'),
    res || jsonb_build_object('contract', c || '{"surprise":1}')]
  loop
    n := n + 1;
    if pg_temp.check_created(m, owner) is null then raise exception 'FAIL negative control % passed: %', n, m; end if;
  end loop;
  raise notice 'PASS % negative controls rejected (null/missing status, owner, id, state, timestamps, ttl, invite, protected field, shape)', n;
end $$;

-- Spoofing: there is no owner/protected parameter; extra named args are refused by the signature.
do $$ begin
  execute 'select public.create_entry_contract(p_project_name=>''p'',p_dod=>''["a"]'',p_amount_minor=>1,p_currency=>''JPY'',p_deadline=>null,p_invited_hirer_email=>''g@example.test'',p_performed_by=>''creator'',p_earner_display_name=>null,p_earner_user_id=>''22222222-2222-4222-8222-222222222222''::uuid)';
  raise exception 'FAIL extra owner argument accepted';
exception when undefined_function then raise notice 'PASS owner spoof argument does not exist'; end $$;
do $$
declare res jsonb;
begin
  perform set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222"}',true);
  res := public.create_entry_contract('p','["a"]',1,'USD',null,'g@example.test','creator',null);
  if pg_temp.check_created(res, '11111111-1111-4111-8111-111111111111') is not null then raise exception 'FAIL claims override sub: %', res->'contract'->>'earner_user_id'; end if;
  perform set_config('request.jwt.claims','',true);
  if res->'contract'->>'amount_jpy' is not null or res->'contract'->>'currency' is distinct from 'USD' then raise exception 'FAIL non-JPY mirror'; end if;
  raise notice 'PASS owner follows request.jwt.claim.sub; USD has no amount_jpy mirror';
end $$;

-- Parity table: each case is (expected field or 'created', inputs...).
do $$
declare
  t record; res jsonb; n0 bigint; n1 bigint; fails int := 0;
  long1000 text := repeat('x',1000);
begin
  n0 := pg_temp.total();
  for t in select * from (values
    ('project_name', null::text, '["a"]'::jsonb, 1, 'JPY', null::date, 'g@example.test', 'creator', null::text),
    ('project_name', '   ', '["a"]', 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('project_name', '', '["a"]', 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('project_name', repeat('p',501), '["a"]', 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('created', repeat('p',500), '["a"]', 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('dod', 'p', null, 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('dod', 'p', '"a"', 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('dod', 'p', '{"a":1}', 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('dod', 'p', '[]', 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('dod', 'p', '[1]', 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('dod', 'p', '[null]', 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('dod', 'p', '[["a"]]', 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('dod', 'p', '["  "]', 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('dod', 'p', to_jsonb(array[repeat('x',1001)]), 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('created', 'p', to_jsonb(array[long1000]), 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('dod', 'p', (select jsonb_agg('a'::text) from generate_series(1,51)), 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('created', 'p', (select jsonb_agg('a'::text) from generate_series(1,50)), 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('dod', 'p', (select jsonb_agg(repeat('x',999)) from generate_series(1,21)), 1, 'JPY', null, 'g@example.test', 'creator', null),
    ('amount_minor', 'p', '["a"]', null, 'JPY', null, 'g@example.test', 'creator', null),
    ('amount_minor', 'p', '["a"]', 0, 'JPY', null, 'g@example.test', 'creator', null),
    ('amount_minor', 'p', '["a"]', -1, 'JPY', null, 'g@example.test', 'creator', null),
    ('created', 'p', '["a"]', 2147483647, 'JPY', null, 'g@example.test', 'creator', null),
    ('currency', 'p', '["a"]', 1, null, null, 'g@example.test', 'creator', null),
    ('currency', 'p', '["a"]', 1, 'jpy', null, 'g@example.test', 'creator', null),
    ('currency', 'p', '["a"]', 1, 'AUD', null, 'g@example.test', 'creator', null),
    ('created', 'p', '["a"]', 1, 'GBP', null, 'g@example.test', 'creator', null),
    ('deadline', 'p', '["a"]', 1, 'JPY', current_date - 2, 'g@example.test', 'creator', null),
    ('created', 'p', '["a"]', 1, 'JPY', current_date - 1, 'g@example.test', 'creator', null),
    ('invited_hirer_email', 'p', '["a"]', 1, 'JPY', null, null, 'creator', null),
    ('invited_hirer_email', 'p', '["a"]', 1, 'JPY', null, '', 'creator', null),
    ('invited_hirer_email', 'p', '["a"]', 1, 'JPY', null, ' g@example.test', 'creator', null),
    ('invited_hirer_email', 'p', '["a"]', 1, 'JPY', null, 'not-an-email', 'creator', null),
    ('performed_by', 'p', '["a"]', 1, 'JPY', null, 'g@example.test', null, null),
    ('performed_by', 'p', '["a"]', 1, 'JPY', null, 'g@example.test', 'Creator', null),
    ('earner_display_name', 'p', '["a"]', 1, 'JPY', null, 'g@example.test', 'creator', repeat('n',201)),
    ('created', 'p', '["a"]', 1, 'JPY', null, 'g@example.test', 'creator', repeat('n',200)),
    ('created', 'p', '["a"]', 1, 'JPY', null, 'g@example.test', 'creator', null)
  ) as v(expect, pn, dod, amt, cur, dl, em, pb, dn) loop
    begin
      res := public.create_entry_contract(t.pn, t.dod, t.amt, t.cur, t.dl, t.em, t.pb, t.dn);
      if (t.expect = 'created' and pg_temp.check_created(res, '11111111-1111-4111-8111-111111111111') is not null)
         or (t.expect <> 'created' and res is distinct from jsonb_build_object('status','invalid_terms','field',t.expect)) then
        raise notice 'FAIL parity expect=% got=% (pn len %, dod %, amt %, cur %, dl %, em %, pb %, dn len %)', t.expect, res, length(t.pn), left(t.dod::text,40), t.amt, t.cur, t.dl, t.em, t.pb, length(t.dn);
        fails := fails + 1;
      end if;
    exception when others then
      raise notice 'FAIL parity expect=% raised % % (dod %)', t.expect, sqlstate, sqlerrm, left(t.dod::text,40);
      fails := fails + 1;
    end;
  end loop;
  n1 := pg_temp.total();
  if (n1 - n0) is distinct from 8 then raise notice 'FAIL parity: % rows created, expected 8', n1 - n0; fails := fails + 1; end if;
  if fails > 0 then raise exception 'parity: % failure(s)', fails; end if;
  raise notice 'PASS parity table (37 cases, 8 created, refusals left no row)';
end $$;

-- Atomicity: a failure after the insert (here a constraint the RPC does not
-- pre-check) must leave no row and propagate, not be reported as created.
reset role;
alter table public.contracts add constraint tf154_probe check (project_name <> 'atomic-probe');
set local role authenticated;
do $$
declare n0 bigint; n1 bigint;
begin
  n0 := pg_temp.total();
  begin
    perform public.create_entry_contract('atomic-probe','["a"]',1,'JPY',null,'g@example.test','creator',null);
    raise exception 'FAIL constraint violation not propagated';
  exception when check_violation then null; end;
  n1 := pg_temp.total();
  if n1 is distinct from n0 then raise exception 'FAIL partial row after error'; end if;
  raise notice 'PASS atomic failure propagates (check_violation), no partial row';
end $$;
reset role;

rollback;

-- READ COMMITTED is required (separate transaction).
begin isolation level repeatable read;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000000',true);
do $$ begin
  perform public.create_entry_contract('p','["a"]',1,'JPY',null,'g@example.test','creator',null);
  raise exception 'FAIL ran under REPEATABLE READ';
exception when sqlstate 'TF005' then raise notice 'PASS refused outside READ COMMITTED (TF005)'; end $$;
rollback;
select 'ALL PASSED';
