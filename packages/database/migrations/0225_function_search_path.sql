-- Standard restores clear the session search_path before COPY evaluates CHECKs.
-- Pin only CHECK entry points with unqualified application references, including
-- the self-recursive canonical helper (also called directly by a CHECK).
-- Other callees inherit their caller's path; triggers are installed after COPY.
-- Change only per-function configuration, preserving the existing bodies.
-- Production objects live in public. Use the migration schema so isolated
-- integration fixtures keep resolving their own objects (never public data).
do $$
declare
  app_schema text := current_schema();
  signature text;
begin
  foreach signature in array array[
    'allrice_automation_conversation_snapshot_valid(s jsonb)',
    'allrice_native_calendar_control_valid(c jsonb)',
    'allrice_native_calendar_revision_valid(v jsonb)',
    'allrice_native_control_canonical(value jsonb)',
    'allrice_native_control_document_digest(value jsonb)'
  ] loop
    execute format('alter function %I.%s set search_path = pg_catalog, %I',
      app_schema, signature, app_schema);
  end loop;
end $$;
