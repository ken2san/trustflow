-- Stage B: route client contract creation through create_entry_contract.
-- This changes privileges and policies only; it does not rewrite contract rows.

revoke insert on table public.contracts from public, anon, authenticated;

do $$
declare
  col record;
begin
  -- Table-level REVOKE does not revoke independently granted column privileges.
  for col in
    select attname from pg_catalog.pg_attribute
    where attrelid = 'public.contracts'::regclass and attnum > 0 and not attisdropped
  loop
    execute format('revoke insert (%I) on public.contracts from public, anon, authenticated', col.attname);
  end loop;
end $$;

drop policy if exists creator_insert_contract on public.contracts;

do $$
declare
  client_role text;
  f oid := 'public.create_entry_contract(text,jsonb,integer,text,date,text,text,text)'::regprocedure;
begin
  -- Effective checks include PUBLIC and inherited grants. Unexpected grants or
  -- permissive policies fail the whole migration instead of opening a bypass.
  foreach client_role in array array['anon', 'authenticated'] loop
    if has_table_privilege(client_role, 'public.contracts', 'INSERT')
       or has_any_column_privilege(client_role, 'public.contracts', 'INSERT') then
      raise exception 'SELF-TEST FAILED: % retains effective INSERT on contracts', client_role;
    end if;
  end loop;

  if not (select relrowsecurity from pg_catalog.pg_class where oid = 'public.contracts'::regclass) then
    raise exception 'SELF-TEST FAILED: contracts RLS is disabled';
  end if;

  foreach client_role in array array['anon', 'authenticated'] loop
    if exists (
      select 1 from pg_catalog.pg_policy p
      cross join lateral unnest(p.polroles) as policy_role(role_oid)
      where p.polrelid = 'public.contracts'::regclass
        and p.polpermissive and p.polcmd in ('a', '*')
        and case when policy_role.role_oid = 0 then true
                 else pg_has_role(client_role::regrole::oid, policy_role.role_oid, 'MEMBER') end
    ) then
      raise exception 'SELF-TEST FAILED: permissive INSERT policy applies to %', client_role;
    end if;
  end loop;

  if not (select prosecdef from pg_catalog.pg_proc where oid = f)
     or not has_function_privilege('authenticated', f, 'EXECUTE')
     or has_function_privilege('anon', f, 'EXECUTE') then
    raise exception 'SELF-TEST FAILED: create_entry_contract privileges or SECURITY DEFINER changed';
  end if;
end $$;

