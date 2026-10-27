-- Canonical digest helpers used by calendar and monthly scheduling.
-- The former offline upgrade ledger is removed from deployed databases by 0218.
create function allrice_native_control_canonical(value jsonb) returns text
  language plpgsql immutable strict as $$
declare result text;
begin
  case jsonb_typeof(value)
    when 'object' then
      select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||allrice_native_control_canonical(v),',' order by key collate "C"),'')||'}'
        into result from jsonb_each(value) as e(key,v);
    when 'array' then
      select '['||coalesce(string_agg(allrice_native_control_canonical(v),',' order by n),'')||']'
        into result from jsonb_array_elements(value) with ordinality as e(v,n);
    else result:=value::text;
  end case;
  return result;
end $$;
create function allrice_native_control_document_digest(value jsonb) returns text
  language sql immutable strict as $$
    select 'sha256:'||encode(sha256(convert_to(allrice_native_control_canonical(value),'UTF8')),'hex')
  $$;
