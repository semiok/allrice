-- MET-283 approved business storage/accounting only, never an execution lifecycle.
-- Not a production authorization: 271/273 must bind B and current source/module
-- authority before enabling an entrypoint. Identity retention/deletion and the
-- scope FK are still awaiting that owner's contract; no cascade is introduced.
create table allrice_employee_memory_contexts (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  instance_id uuid not null,
  employee_id uuid not null,
  budget_ref text not null check (char_length(budget_ref) > 0),
  thread_id uuid not null,
  native_owner_ref text not null check (char_length(native_owner_ref) > 0),
  native_profile_ref text not null check (char_length(native_profile_ref) > 0),
  root_native_session_ref text not null check (char_length(root_native_session_ref) > 0),
  execution_generation text not null check (execution_generation = '4.0'),
  module_release jsonb not null check (jsonb_typeof(module_release) = 'object'),
  module_config_revision_ref text not null check (char_length(module_config_revision_ref) > 0),
  -- memory-index-v2-native-mcp-v1 content, not a separately mutable format state.
  -- Existing V2 UTF-8 maximum: employee-documents.ts:9 / memoryIndexPolicy.
  document text not null check (octet_length(document) <= 18303),
  state jsonb not null check (
    jsonb_typeof(state) = 'object'
    and state @> '{"schemaVersion":2,"meter":"utf8_bytes"}'::jsonb
  ),
  issued_at timestamptz not null default clock_timestamp(),
  primary key (organization_id,workspace_id,owner_id,instance_id,id),
  unique (organization_id,workspace_id,owner_id,instance_id,budget_ref)
);
