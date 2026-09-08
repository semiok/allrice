-- Expand execution identity without pretending a remote MCP service is a VM.
alter table allrice_execution_targets drop constraint allrice_execution_targets_kind_check;
alter table allrice_execution_targets add constraint allrice_execution_targets_kind_check
  check (kind in ('cloud_sandbox','rice_bridge','cloud_mcp'));

create table allrice_mcp_execution_inputs (
  operation_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  run_id uuid not null references allrice_runs(id),
  binding_id uuid not null,
  job_id uuid not null references allrice_jobs(id),
  worker_id uuid not null,
  job_lease_token text not null,
  binding jsonb not null,
  payload jsonb not null check (octet_length(payload::text) <= 300000),
  created_at timestamptz not null default now(),
  foreign key (organization_id,workspace_id,binding_id)
    references allrice_mcp_binding_config(organization_id,workspace_id,binding_id)
);
-- Records dispatch ownership before network access; process death never grants
-- permission to replay an already-started tools/call.
create table allrice_mcp_execution_attempts (
  operation_id uuid primary key references allrice_mcp_execution_inputs(operation_id),
  lease_token text not null,
  result jsonb,
  created_at timestamptz not null default now()
);

create function allrice_mcp_execution_input_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'MCP execution inputs are immutable';
end $$;
create trigger allrice_mcp_execution_inputs_immutable before update or delete
  on allrice_mcp_execution_inputs for each row execute function allrice_mcp_execution_input_immutable();
create function allrice_mcp_execution_attempt_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or new.operation_id is distinct from old.operation_id
    or new.lease_token is distinct from old.lease_token
    or new.created_at is distinct from old.created_at
    or (old.result is not null and new.result is distinct from old.result) then
    raise exception 'MCP execution attempt identity/result are immutable';
  end if;
  return new;
end $$;
create trigger allrice_mcp_execution_attempts_immutable before update or delete
  on allrice_mcp_execution_attempts for each row execute function allrice_mcp_execution_attempt_immutable();

create function allrice_mcp_tool_revision_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'MCP discovered tool revisions are immutable';
end $$;
create trigger allrice_mcp_tool_revisions_immutable before update or delete
  on allrice_mcp_tool_revisions for each row execute function allrice_mcp_tool_revision_immutable();
