-- Run only against an isolated local test database with the task migration applied.
begin;
insert into auth.users (id,email,is_anonymous,email_confirmed_at) values
  ('11111111-1111-4111-8111-111111111111','owner@example.test',false,clock_timestamp()),
  ('22222222-2222-4222-8222-222222222222','guest@example.test',false,clock_timestamp()),
  ('33333333-3333-4333-8333-333333333333','other@example.test',false,clock_timestamp()),
  ('44444444-4444-4444-8444-444444444444','unverified@example.test',false,null);
insert into public.contracts (id,earner_user_id,project_name,dod,amount_jpy,invited_hirer_email,invite_token,invite_token_expires_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','test','["test"]'::jsonb,1,'guest@example.test','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',clock_timestamp()+interval '1 day');
do $$
declare r jsonb; v_contract_id uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; role_name text; privilege_name text; fn text; col text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege(role_name,'public.entry_agent_credentials',privilege_name) then raise exception 'client table privilege: % %', role_name, privilege_name; end if;
    end loop;
    foreach fn in array array['public.issue_entry_agent_credential(uuid,uuid,uuid,text,text,text[],timestamptz,text)', 'public.revoke_entry_agent_credential(uuid,uuid,uuid)', 'public.list_entry_agent_credentials(uuid,uuid)'] loop
      if has_function_privilege(role_name,fn,'EXECUTE') then raise exception 'client function privilege: % %', role_name, fn; end if;
    end loop;
    for col in select a.attname from pg_attribute a where a.attrelid = 'public.entry_agent_credentials'::regclass and a.attnum > 0 and not a.attisdropped loop
      foreach privilege_name in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
        if has_column_privilege(role_name,'public.entry_agent_credentials',col,privilege_name) then
          raise exception 'effective client column privilege: % % %', role_name, col, privilege_name;
        end if;
      end loop;
    end loop;
  end loop;
  if exists (select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where c.oid = 'public.entry_agent_credentials'::regclass and a.grantee = 0)
    or exists (select 1 from pg_attribute c, lateral aclexplode(c.attacl) a where c.attrelid = 'public.entry_agent_credentials'::regclass and a.grantee = 0) then
    raise exception 'PUBLIC credential privilege';
  end if;
  if has_column_privilege('authenticated','public.contracts','counterpart_account_id','UPDATE') or has_column_privilege('authenticated','public.contracts','counterpart_account_id','INSERT') then raise exception 'client can set counterpart'; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-1111-4111-8111-111111111111',v_contract_id,'11111111-1111-4111-8111-111111111111','owner_account',repeat('a',64),array['read'],clock_timestamp()+interval '1 day',null);
  if r->>'status' <> 'issued' then raise exception 'owner denied: %',r; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-2222-4222-8222-222222222222',v_contract_id,'11111111-1111-4111-8111-111111111111','counterpart_account',repeat('b',64),array['accept'],clock_timestamp()+interval '1 day','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  if r->>'status' <> 'not_authorized' then raise exception 'owner as counterpart admitted'; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-2222-4222-8222-222222222222',v_contract_id,'22222222-2222-4222-8222-222222222222','counterpart_account',repeat('b',64),array['accept'],clock_timestamp()+interval '1 day','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  if r->>'status' <> 'issued' then raise exception 'counterpart denied: %',r; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-3333-4333-8333-333333333333',v_contract_id,'33333333-3333-4333-8333-333333333333','counterpart_account',repeat('c',64),array['read'],clock_timestamp()+interval '1 day','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  if r->>'status' <> 'not_authorized' then raise exception 'mismatched email admitted'; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-4444-4444-8444-444444444444',v_contract_id,'44444444-4444-4444-8444-444444444444','counterpart_account',repeat('d',64),array['read'],clock_timestamp()+interval '1 day','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  if r->>'status' <> 'not_authorized' then raise exception 'unverified email admitted'; end if;
  insert into public.contracts (id,earner_user_id,project_name,dod,amount_jpy) values
    ('ffffffff-ffff-4fff-8fff-ffffffffffff','44444444-4444-4444-8444-444444444444','unverified owner','["test"]'::jsonb,1);
  r := public.issue_entry_agent_credential('ffffffff-1111-4111-8111-111111111111','ffffffff-ffff-4fff-8fff-ffffffffffff','44444444-4444-4444-8444-444444444444','owner_account',repeat('f',64),array['read'],clock_timestamp()+interval '1 day',null);
  if r->>'status' <> 'not_authorized' then raise exception 'unverified owner admitted'; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-4444-4444-8444-444444444444',v_contract_id,'22222222-2222-4222-8222-222222222222','counterpart_account',repeat('d',64),array['accept'],clock_timestamp()+interval '1 day','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  if r->>'status' <> 'not_authorized' then raise exception 'wrong invite admitted'; end if;
  update public.contracts set invite_token_expires_at = clock_timestamp()-interval '1 second' where contracts.id=v_contract_id;
  r := public.issue_entry_agent_credential('aaaaaaaa-4444-4444-8444-444444444444',v_contract_id,'22222222-2222-4222-8222-222222222222','counterpart_account',repeat('d',64),array['read'],clock_timestamp()+interval '1 day','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  if r->>'status' <> 'not_authorized' then raise exception 'expired invite admitted'; end if;
  update public.contracts set invite_token_expires_at = clock_timestamp()+interval '1 day' where contracts.id=v_contract_id;
  r := public.issue_entry_agent_credential('aaaaaaaa-4444-4444-8444-444444444444',v_contract_id,'11111111-1111-4111-8111-111111111111','owner_account',repeat('d',64),array['read'],clock_timestamp()-interval '1 second',null);
  if r->>'status' <> 'invalid_grant' then raise exception 'expired grant admitted'; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-3333-4333-8333-333333333333',v_contract_id,'11111111-1111-4111-8111-111111111111','owner_account',repeat('c',64),array['read','read'],clock_timestamp()+interval '1 day',null);
  if r->>'status' <> 'invalid_grant' then raise exception 'duplicate scopes admitted'; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-3333-4333-8333-333333333333',v_contract_id,'11111111-1111-4111-8111-111111111111','owner_account',repeat('c',64),array['read',null],clock_timestamp()+interval '1 day',null);
  if r->>'status' <> 'invalid_grant' then raise exception 'null scope admitted'; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-3333-4333-8333-333333333333',v_contract_id,'11111111-1111-4111-8111-111111111111','owner_account',repeat('c',64),array['read','unknown'],clock_timestamp()+interval '1 day',null);
  if r->>'status' <> 'invalid_grant' then raise exception 'unknown scope admitted'; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-3333-4333-8333-333333333333',v_contract_id,'11111111-1111-4111-8111-111111111111','owner_account',repeat('c',64),array['read'],'infinity'::timestamptz,null);
  if r->>'status' <> 'invalid_grant' then raise exception 'infinite expiry admitted'; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-3333-4333-8333-333333333333',v_contract_id,'11111111-1111-4111-8111-111111111111','owner_account',repeat('c',64),array['read'],clock_timestamp()+interval '30 days 1 second',null);
  if r->>'status' <> 'invalid_grant' then raise exception 'expiry beyond 30 days admitted'; end if;
  r := public.issue_entry_agent_credential('aaaaaaaa-3333-4333-8333-333333333333',v_contract_id,'11111111-1111-4111-8111-111111111111','owner_account',repeat('c',64),array['read'],'9999-12-31T00:00:00Z'::timestamptz,null);
  if r->>'status' <> 'invalid_grant' then raise exception 'year 9999 expiry admitted'; end if;
  begin
    insert into public.entry_agent_credentials (id,contract_id,issuer_id,issuer_kind,secret_hash,scopes,expires_at)
      values ('aaaaaaaa-5555-4555-8555-555555555555',v_contract_id,'11111111-1111-4111-8111-111111111111','owner_account',repeat('5',64),array['read'],clock_timestamp()+interval '31 days');
    raise exception 'table admitted expiry beyond 30 days';
  exception when check_violation then null; end;
  r := public.issue_entry_agent_credential('aaaaaaaa-6666-4666-8666-666666666666',v_contract_id,'11111111-1111-4111-8111-111111111111','owner_account',repeat('6',64),array['read'],clock_timestamp()+interval '29 days',null);
  if r->>'status' <> 'issued' then raise exception '29-day expiry denied: %', r; end if;
  r := public.revoke_entry_agent_credential(v_contract_id,'aaaaaaaa-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111');
  if r->>'status' <> 'not_authorized' then raise exception 'owner revoked counterpart grant'; end if;
  r := public.revoke_entry_agent_credential(v_contract_id,'aaaaaaaa-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222222');
  if r->>'status' <> 'revoked' then raise exception 'issuer revocation denied'; end if;
  r := public.list_entry_agent_credentials(v_contract_id,'22222222-2222-4222-8222-222222222222');
  if r::text like '%secret_hash%' or r::text like '%invite_hash%' or jsonb_array_length(r) <> 1 then raise exception 'list leaked hashes or wrong count'; end if;
  update public.contracts set invite_token_used_at = clock_timestamp() where contracts.id=v_contract_id;
  r := public.issue_entry_agent_credential('aaaaaaaa-3333-4333-8333-333333333333',v_contract_id,'22222222-2222-4222-8222-222222222222','counterpart_account',repeat('c',64),array['read'],clock_timestamp()+interval '1 day',null);
  if r->>'status' <> 'not_authorized' then raise exception 'bearer accepted contract admitted'; end if;
  update public.contracts set counterpart_account_id='22222222-2222-4222-8222-222222222222' where contracts.id=v_contract_id;
  r := public.issue_entry_agent_credential('aaaaaaaa-3333-4333-8333-333333333333',v_contract_id,'22222222-2222-4222-8222-222222222222','counterpart_account',repeat('c',64),array['read'],clock_timestamp()+interval '1 day',null);
  if r->>'status' <> 'issued' then raise exception 'stored counterpart denied'; end if;
end $$;
insert into public.contracts (id,earner_user_id,project_name,dod,amount_jpy) values
  ('eeeeeeee-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','expired grant draft','["test"]'::jsonb,1),
  ('eeeeeeee-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','revoked grant draft','["test"]'::jsonb,1);
insert into public.entry_agent_credentials (id,contract_id,issuer_id,issuer_kind,secret_hash,scopes,created_at,expires_at,revoked_at) values
  ('eeeeeeee-1111-4111-8111-222222222222','eeeeeeee-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','owner_account',repeat('e',64),array['read'],clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',null),
  ('eeeeeeee-2222-4222-8222-333333333333','eeeeeeee-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','owner_account',repeat('f',64),array['read'],clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',clock_timestamp());
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$
declare v_id uuid;
begin
  foreach v_id in array array['eeeeeeee-1111-4111-8111-111111111111'::uuid,'eeeeeeee-2222-4222-8222-222222222222'::uuid] loop
    begin
      delete from public.contracts where id = v_id;
      raise exception 'owner did not receive grant refusal for %', v_id;
    exception when sqlstate 'TF007' then null; end;
  end loop;
end $$;
reset role;
set local role authenticated;
do $$
begin
  begin
    perform public.list_entry_agent_credentials('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111');
    raise exception 'authenticated invoked privileged list RPC';
  exception when insufficient_privilege then null; end;
  begin
    perform public.revoke_entry_agent_credential('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111');
    raise exception 'authenticated invoked privileged revoke RPC';
  exception when insufficient_privilege then null; end;
  begin
    perform public.issue_entry_agent_credential('99999999-9999-4999-8999-999999999999','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','owner_account',repeat('9',64),array['read'],clock_timestamp()+interval '1 day',null);
    raise exception 'authenticated invoked privileged issue RPC';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$
declare
  v_contract_id uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_grant_id uuid := 'aaaaaaaa-2222-4222-8222-222222222222';
begin
  insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy)
    values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '11111111-1111-4111-8111-111111111111', 'empty draft', '["test"]'::jsonb, 1);
  delete from public.contracts where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  if found is false then raise exception 'empty draft was not deleted'; end if;
  begin
    update public.entry_agent_credentials set issuer_kind = 'owner_account' where id = v_grant_id;
    raise exception 'grant evidence was rewritten';
  exception when sqlstate 'TF008' then null; end;
  begin
    update public.entry_agent_credentials set revoked_at = null where id = v_grant_id;
    raise exception 'revocation was undone';
  exception when sqlstate 'TF008' then null; end;
  begin
    delete from public.entry_agent_credentials where id = v_grant_id;
    raise exception 'grant was deleted';
  exception when sqlstate 'TF008' then null; end;
  begin
    truncate public.entry_agent_credentials;
    raise exception 'grants were truncated';
  exception when sqlstate 'TF008' then null; end;
  begin
    delete from public.contracts where id = v_contract_id;
    raise exception 'draft with grant was deleted';
  exception when sqlstate 'TF007' then null; end;
  if has_table_privilege('service_role', 'public.entry_agent_credentials', 'UPDATE')
    or has_table_privilege('service_role', 'public.entry_agent_credentials', 'DELETE')
    or has_table_privilege('service_role', 'public.entry_agent_credentials', 'TRUNCATE')
    or has_table_privilege('service_role', 'public.entry_agent_credentials', 'INSERT') then
    raise exception 'service role can mutate grants directly';
  end if;
end $$;
set local role service_role;
do $$
begin
  begin
    update public.entry_agent_credentials set revoked_at = null;
    raise exception 'service role updated grants directly';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.entry_agent_credentials;
    raise exception 'service role deleted grants directly';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.contracts where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'service role deleted a draft with a grant';
  exception when sqlstate 'TF007' then null; end;
end $$;
reset role;
rollback;
