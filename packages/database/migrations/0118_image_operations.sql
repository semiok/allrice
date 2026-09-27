-- Durable image receipts: a provider timeout never grants permission to replay.
alter table allrice_deliverable_versions drop constraint allrice_deliverable_versions_format_check;
alter table allrice_deliverable_versions add constraint allrice_deliverable_versions_format_check
  check (format in ('markdown','text','html','json','docx','xlsx','pptx','pdf','png'));

create table allrice_image_operations (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  run_id uuid not null,
  session_id uuid not null,
  call_id text not null,
  input_digest text not null,
  operation text not null check (operation in ('generate','edit')),
  work_model text not null,
  image_model text not null,
  source_object_id uuid references allrice_storage_objects(id),
  source_checksum text,
  status text not null check (status in ('running','succeeded','failed','unknown')),
  result jsonb,
  usage jsonb,
  provider_request_id text,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (run_id, call_id),
  unique (run_id, input_digest),
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id)
);
create index allrice_image_operations_recent on allrice_image_operations(created_at desc);
