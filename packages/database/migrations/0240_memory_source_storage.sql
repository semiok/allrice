-- MET-223 A1: empty memory-owned source ledger. No legacy policy/source copy.
-- Sources are unconfirmed provenance, never allrice_memories candidates.
create table allrice_memory_sources (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  employee_id uuid not null references allrice_employees(id),
  instance_id uuid not null,
  capture_run_id uuid not null,
  run_id uuid not null,
  session_id uuid not null,
  message_id uuid not null,
  source_key text not null check (source_key ~ '^sha256:[a-f0-9]{64}$'),
  source_excerpt text not null,
  source_digest text not null check (source_digest ~ '^sha256:[a-f0-9]{64}$'),
  evidence jsonb not null check (jsonb_typeof(evidence)='object' and evidence->>'schemaVersion'='2'),
  created_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz,
  foreign key (organization_id,workspace_id,owner_id,instance_id)
    references allrice_employee_instances(organization_id,workspace_id,owner_id,id),
  foreign key (organization_id,workspace_id,capture_run_id)
    references allrice_runs(organization_id,workspace_id,id),
  foreign key (organization_id,workspace_id,run_id)
    references allrice_runs(organization_id,workspace_id,id),
  foreign key (organization_id,workspace_id,session_id)
    references allrice_chat_sessions(organization_id,workspace_id,id),
  foreign key (organization_id,workspace_id,message_id)
    references allrice_messages(organization_id,workspace_id,id),
  unique (organization_id,workspace_id,owner_id,instance_id,source_key)
);

alter table allrice_employee_runs
  add column memory_source_capture_state text check (memory_source_capture_state in ('pending','captured','ignored')),
  add column memory_source_capture_reason text,
  add column memory_source_captured_at timestamptz,
  add column memory_source_execution_run_id uuid,
  add foreign key (organization_id,workspace_id,memory_source_execution_run_id)
    references allrice_runs(organization_id,workspace_id,id),
  add check (memory_source_execution_run_id is null or memory_source_execution_run_id<>run_id);
create index allrice_memory_source_capture_pending on allrice_employee_runs(completed_at,run_id)
  where memory_source_capture_state='pending';

-- Configuration is an explicit organization allrice_settings entry with key
-- employee_memory_source_policy. Intentionally insert no settings or defaults.
-- Old employee_experience_policy and terminal markers remain untouched for A2.
