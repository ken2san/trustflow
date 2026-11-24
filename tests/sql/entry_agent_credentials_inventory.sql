-- Read-only bypass inventory for the credential store. SELECTs and notices only,
-- so it may run against a read-only session on any catalog, with or without the
-- credential migration applied. It fails if anything anon or authenticated can
-- reach with its owner's rights names the credential table or the counterpart
-- column outside the five functions the credential migration defines and the
-- row 4 resolver (20261124120000), which locks and reads grants for the writers,
-- the writers' lock-free precheck (20261124130000), and the row 5 owner-read
-- helper (20261124231214), which locks and reads the grant for the read RPC.
-- Bodies in C or another opaque language cannot be scanned; they are listed.
do $$
declare
  t record;
  v_bad int := 0;
  v_allowed oid[] := array(select to_regprocedure(x) from unnest(array[
    'public.issue_entry_agent_credential(uuid,uuid,uuid,text,text,text[],timestamptz,text)',
    'public.revoke_entry_agent_credential(uuid,uuid,uuid)',
    'public.list_entry_agent_credentials(uuid,uuid)',
    'public.protect_entry_agent_credential_evidence()',
    'public.refuse_delete_of_contract_with_evidence()',
    'private.resolve_entry_agent_grant(uuid,uuid,text,text,boolean)',
    'private.v5_grant_precheck(uuid,uuid,text)',
    'private.resolve_owner_read_grant(uuid,uuid,text)']) as x where to_regprocedure(x) is not null);
begin
  -- SECURITY DEFINER functions a client role may execute.
  for t in
    select p.oid, p.oid::regprocedure::text as fn, l.lanname,
           p.prorettype = 'trigger'::regtype as is_trigger,
           p.prosrc ilike '%entry_agent_credentials%' or p.prosrc ilike '%counterpart_account_id%' as names_target
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
      and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    order by 2
  loop
    if t.lanname not in ('sql', 'plpgsql') then
      raise notice 'DEFINER % [%]: opaque body, not scanned', t.fn, t.lanname;
    elsif t.names_target and not t.oid = any(v_allowed) then
      raise notice 'FAIL DEFINER % names the credential table or counterpart column', t.fn;
      v_bad := v_bad + 1;
    else
      raise notice 'DEFINER %: %', t.fn || case when t.is_trigger then ' (trigger, not directly callable)' else '' end,
        case when t.names_target then 'allowed credential function' else 'does not name either target' end;
    end if;
  end loop;

  -- Any function, definer or not, naming a target: a BEFORE trigger can set a
  -- column regardless of column grants.
  for t in
    select p.oid::regprocedure::text as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema')
      and (p.prosrc ilike '%entry_agent_credentials%' or p.prosrc ilike '%counterpart_account_id%')
      and not p.oid = any(v_allowed)
  loop
    raise notice 'FAIL function % names the credential table or counterpart column', t.fn;
    v_bad := v_bad + 1;
  end loop;

  -- Views without security_invoker run with their owner's rights.
  for t in
    select c.oid::regclass::text as rel, c.relkind,
           pg_get_viewdef(c.oid) ilike '%entry_agent_credentials%'
             or pg_get_viewdef(c.oid) ilike '%counterpart_account_id%' as names_target
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('v', 'm') and n.nspname not in ('pg_catalog', 'information_schema')
      and not exists (select 1 from unnest(coalesce(c.reloptions, '{}')) o
                      where o in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1'))
      and (has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
           or has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE'))
    order by 1
  loop
    if t.names_target then
      raise notice 'FAIL VIEW % names the credential table or counterpart column', t.rel;
      v_bad := v_bad + 1;
    else
      raise notice 'VIEW % (owner rights): does not name either target', t.rel;
    end if;
  end loop;

  -- Rules on tables, which can redirect a client write.
  for t in
    select format('%I.%I', w.schemaname, w.rulename) as rule from pg_rules w
    where w.schemaname not in ('pg_catalog', 'information_schema')
      and (w.definition ilike '%entry_agent_credentials%' or w.definition ilike '%counterpart_account_id%')
  loop
    raise notice 'FAIL RULE % names the credential table or counterpart column', t.rule;
    v_bad := v_bad + 1;
  end loop;

  if exists (select 1 from pg_extension where extname = 'pg_graphql') then
    raise notice 'pg_graphql installed: %', (select extversion from pg_extension where extname = 'pg_graphql');
  else
    raise notice 'pg_graphql not installed';
  end if;

  if v_bad > 0 then
    raise exception 'bypass inventory: % finding(s)', v_bad;
  end if;
  raise notice 'bypass inventory: PASS';
end $$;
