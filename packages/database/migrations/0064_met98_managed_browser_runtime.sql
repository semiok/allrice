-- MET-98 P1-3: make managed browser tasks executable, cancelable, and
-- replayable through immutable, tenant-scoped evidence artifacts.

alter table allrice_managed_browser_tasks
  add column steps jsonb not null default '[]'::jsonb
    check (jsonb_typeof(steps) = 'array'),
  add column cancel_requested_at timestamptz,
  add constraint allrice_browser_task_error_code_length
    check (error_code is null or length(error_code) <= 160),
  add constraint allrice_browser_task_started_after_create
    check (started_at is null or started_at >= created_at),
  add constraint allrice_browser_task_cancel_after_create
    check (cancel_requested_at is null or cancel_requested_at >= created_at),
  add constraint allrice_browser_task_completed_after_create
    check (completed_at is null or completed_at >= created_at);

-- Normalize rows created by the earlier evidence-ledger-only implementation
-- before enforcing the executable task state machine.
update allrice_managed_browser_tasks
set started_at = coalesce(started_at, created_at)
where status in ('running', 'succeeded', 'failed');

update allrice_managed_browser_tasks
set completed_at = coalesce(completed_at, started_at, created_at)
where status in ('succeeded', 'failed', 'canceled');

update allrice_managed_browser_tasks
set started_at = null, completed_at = null
where status = 'queued';

alter table allrice_managed_browser_tasks
  add constraint allrice_browser_task_state_timestamps check (
    (status = 'queued' and started_at is null and completed_at is null)
    or (status = 'running' and started_at is not null and completed_at is null)
    or (status in ('succeeded', 'failed')
        and started_at is not null and completed_at is not null)
    or (status = 'canceled' and completed_at is not null)
  );

create table allrice_managed_browser_evidence_artifacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  workspace_id uuid not null,
  task_id uuid not null,
  object_id uuid not null,
  kind text not null check (kind in ('content', 'screenshot', 'download')),
  name text not null check (length(name) between 1 and 255),
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, task_id)
    references allrice_managed_browser_tasks(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, object_id)
    references allrice_storage_objects(organization_id, workspace_id, id),
  unique (task_id, object_id),
  constraint allrice_browser_evidence_object_unique
    unique (organization_id, workspace_id, object_id),
  unique (organization_id, workspace_id, id)
);

create function allrice_reject_browser_evidence_artifact_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'managed browser evidence artifacts are immutable';
end;
$$;

create trigger allrice_browser_evidence_artifacts_no_update
before update on allrice_managed_browser_evidence_artifacts
for each row execute function allrice_reject_browser_evidence_artifact_mutation();

create trigger allrice_browser_evidence_artifacts_no_delete
before delete on allrice_managed_browser_evidence_artifacts
for each row execute function allrice_reject_browser_evidence_artifact_mutation();

create index allrice_browser_tasks_execution_queue
  on allrice_managed_browser_tasks (
    organization_id, workspace_id, status, created_at, id
  ) where status in ('queued', 'running');

create index allrice_browser_tasks_cancel_requests
  on allrice_managed_browser_tasks (
    organization_id, workspace_id, cancel_requested_at, id
  ) where status = 'running' and cancel_requested_at is not null;

create index allrice_browser_evidence_task
  on allrice_managed_browser_evidence_artifacts (
    organization_id, workspace_id, task_id, created_at, id
  );

insert into allrice_runtime_metadata (key, value)
values (
  'met98-managed-browser-runtime',
  '{"version":"0064","issue":"MET-98","browser":"isolated-runtime","cancellation":"task-and-run","evidence":"immutable-private-artifacts"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
