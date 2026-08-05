alter table allrice_employee_versions
  add column description text not null default '',
  add column manifest jsonb not null default '{}'::jsonb,
  add column provider_snapshot jsonb,
  add column skill_version_ids jsonb not null default '[]'::jsonb;

create function allrice_reject_employee_version_mutation()
returns trigger language plpgsql as $$
begin
  if
    new.organization_id is distinct from old.organization_id or
    new.workspace_id is distinct from old.workspace_id or
    new.employee_id is distinct from old.employee_id or
    new.version is distinct from old.version or
    new.name is distinct from old.name or
    new.description is distinct from old.description or
    new.model is distinct from old.model or
    new.system_prompt is distinct from old.system_prompt or
    new.capabilities is distinct from old.capabilities or
    new.manifest is distinct from old.manifest or
    new.provider_snapshot is distinct from old.provider_snapshot or
    new.skill_version_ids is distinct from old.skill_version_ids or
    new.config_checksum is distinct from old.config_checksum or
    new.published_at is distinct from old.published_at
  then
    raise exception 'published employee versions are immutable';
  end if;
  return new;
end;
$$;

create trigger allrice_employee_versions_immutable
before update on allrice_employee_versions
for each row execute function allrice_reject_employee_version_mutation();

create function allrice_reject_employee_version_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'published employee versions cannot be deleted';
end;
$$;

create trigger allrice_employee_versions_no_delete
before delete on allrice_employee_versions
for each row execute function allrice_reject_employee_version_delete();

create table allrice_employee_runs (
  run_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  employee_assignment_id uuid not null,
  employee_version_id uuid not null,
  session_id uuid not null,
  user_message_id uuid not null,
  assistant_message_id uuid not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  provider_snapshot jsonb not null,
  skill_bindings jsonb not null default '[]'::jsonb,
  prompt_snapshot jsonb not null,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, employee_assignment_id)
    references allrice_employee_assignments(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, employee_version_id)
    references allrice_employee_versions(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, session_id)
    references allrice_chat_sessions(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, user_message_id)
    references allrice_messages(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, assistant_message_id)
    references allrice_messages(organization_id, workspace_id, id),
  unique (organization_id, workspace_id, run_id),
  unique (organization_id, workspace_id, assistant_message_id),
  unique (organization_id, workspace_id, user_message_id)
);

create table allrice_employee_run_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  run_id uuid not null,
  sequence integer not null check (sequence >= 0),
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, run_id)
    references allrice_employee_runs(organization_id, workspace_id, run_id),
  unique (run_id, sequence)
);

create function allrice_reject_employee_run_snapshot_mutation()
returns trigger language plpgsql as $$
begin
  if
    new.organization_id is distinct from old.organization_id or
    new.workspace_id is distinct from old.workspace_id or
    new.owner_id is distinct from old.owner_id or
    new.employee_assignment_id is distinct from old.employee_assignment_id or
    new.employee_version_id is distinct from old.employee_version_id or
    new.session_id is distinct from old.session_id or
    new.user_message_id is distinct from old.user_message_id or
    new.assistant_message_id is distinct from old.assistant_message_id or
    new.provider_snapshot is distinct from old.provider_snapshot or
    new.skill_bindings is distinct from old.skill_bindings or
    new.prompt_snapshot is distinct from old.prompt_snapshot or
    new.created_at is distinct from old.created_at
  then
    raise exception 'employee run execution snapshots are immutable';
  end if;
  return new;
end;
$$;

create trigger allrice_employee_runs_snapshot_immutable
before update on allrice_employee_runs
for each row execute function allrice_reject_employee_run_snapshot_mutation();

create function allrice_reject_employee_run_evidence_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'employee run evidence is append-only';
end;
$$;

create trigger allrice_employee_runs_no_delete
before delete on allrice_employee_runs
for each row execute function allrice_reject_employee_run_evidence_mutation();

create trigger allrice_employee_run_steps_no_update
before update on allrice_employee_run_steps
for each row execute function allrice_reject_employee_run_evidence_mutation();

create trigger allrice_employee_run_steps_no_delete
before delete on allrice_employee_run_steps
for each row execute function allrice_reject_employee_run_evidence_mutation();

create index allrice_employee_runs_session
  on allrice_employee_runs (
    organization_id, workspace_id, session_id, created_at desc
  );
create index allrice_employee_versions_history
  on allrice_employee_versions (
    organization_id, workspace_id, employee_id, version desc
  );

insert into allrice_runtime_metadata (key, value)
values (
  'employeehub-schema',
  '{"version":"0007","defaultEmployee":"Rice","provider":"codex","authMode":"chatgpt_subscription"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
