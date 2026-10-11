-- Creation-time rules, deliberately outside CHECK constraints: elapsed deadlines
-- must never prevent legitimate later state transitions on existing agreements.
-- BEFORE INSERT applies equally to browser PostgREST, agent calls and future RPCs.
-- Does not change identity, RLS, existing agreements or the immutable event trail.
create or replace function public.validate_contract_creation_only()
returns trigger language plpgsql set search_path = '' as $$
declare
  item jsonb;
begin
  if new.deadline is not null
     and new.deadline < (current_date - 1) then
    raise exception 'deadline_in_the_past'
      using errcode = '23514', constraint = 'contracts_deadline_at_creation';
  end if;
  if pg_catalog.jsonb_typeof(new.dod) = 'array' then
    for item in select value from pg_catalog.jsonb_array_elements(new.dod) as t(value)
    loop
      if pg_catalog.jsonb_typeof(item) = 'string'
         and pg_catalog.length(item #>> '{}') > 1000 then
        raise exception 'dod_item_too_long'
          using errcode = '23514', constraint = 'contracts_dod_item_at_creation';
      end if;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists validate_contract_creation_only on public.contracts;
create trigger validate_contract_creation_only
  before insert on public.contracts
  for each row execute function public.validate_contract_creation_only();
