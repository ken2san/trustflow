-- Stage A: additive authenticated creation. Direct INSERT is closed separately.
create function public.create_entry_contract(
  p_project_name text, p_dod jsonb, p_amount_minor integer, p_currency text,
  p_deadline date, p_invited_hirer_email text, p_performed_by text, p_earner_display_name text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  u auth.users%rowtype;
  c public.contracts%rowtype;
  item jsonb;
  bad text;
begin
  perform public.require_read_committed('creating an agreement');
  if auth.uid() is null then return jsonb_build_object('status','not_authorized'); end if;
  select * into u from auth.users where id = auth.uid() for share;
  if not found or u.is_anonymous is distinct from false or u.email_confirmed_at is null then
    return jsonb_build_object('status','not_authorized');
  end if;
  if p_project_name is null or btrim(p_project_name) = '' or length(p_project_name) > 500 then bad := 'project_name';
  elsif p_dod is null or jsonb_typeof(p_dod) <> 'array' then bad := 'dod';
  elsif jsonb_array_length(p_dod) not between 1 and 50 or length(p_dod::text) > 20000 then bad := 'dod';
  elsif p_amount_minor is null or p_amount_minor <= 0 then bad := 'amount_minor';
  elsif p_currency is null or p_currency not in ('JPY','CAD','HKD','USD','EUR','GBP') then bad := 'currency';
  elsif p_deadline is not null and p_deadline < current_date - 1 then bad := 'deadline';
  elsif p_invited_hirer_email is null or p_invited_hirer_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then bad := 'invited_hirer_email';
  elsif p_performed_by is null or p_performed_by not in ('creator','counterparty') then bad := 'performed_by';
  elsif length(p_earner_display_name) > 200 then bad := 'earner_display_name';
  end if;
  if bad is null then
    for item in select value from jsonb_array_elements(p_dod) loop
      if jsonb_typeof(item) <> 'string' or (item #>> '{}') ~ '^[[:space:]]*$' or length(item #>> '{}') > 1000 then
        bad := 'dod'; exit;
      end if;
    end loop;
  end if;
  if bad is not null then return jsonb_build_object('status','invalid_terms','field',bad); end if;
  insert into public.contracts (earner_user_id,project_name,dod,amount_minor,currency,deadline,invited_hirer_email,performed_by,earner_display_name)
  values (u.id,p_project_name,p_dod,p_amount_minor,p_currency,p_deadline,p_invited_hirer_email,p_performed_by,p_earner_display_name)
  returning * into c;
  return jsonb_build_object('status','created','contract',to_jsonb(c));
end $$;
revoke all on function public.create_entry_contract(text,jsonb,integer,text,date,text,text,text) from public, anon, authenticated;
grant execute on function public.create_entry_contract(text,jsonb,integer,text,date,text,text,text) to authenticated;
do $$
declare f oid := 'public.create_entry_contract(text,jsonb,integer,text,date,text,text,text)'::regprocedure;
begin
  if has_function_privilege('anon',f,'execute') or has_function_privilege('public',f,'execute')
     or not has_function_privilege('authenticated',f,'execute')
     or not (select prosecdef and 'search_path=""' = any(proconfig) from pg_proc where oid=f)
     or not has_any_column_privilege((select pg_get_userbyid(proowner) from pg_proc where oid=f),'auth.users','UPDATE') then
    raise exception 'create_entry_contract privilege self-test failed';
  end if;
end $$;
