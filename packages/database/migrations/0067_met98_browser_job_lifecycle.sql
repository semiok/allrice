-- MET-98 P1-3: bind every managed browser task to the exact durable job
-- attempt that created it. This lets queue recovery deterministically close
-- browser work left behind by a crashed or lease-lost worker.

alter table allrice_managed_browser_tasks
  add column job_id uuid,
  add column job_attempt integer,
  add column tool_call_id text;

update allrice_managed_browser_tasks task
set job_id = job.id,
    job_attempt = greatest(job.attempt, 1),
    tool_call_id = 'legacy:' || task.id::text
from allrice_jobs job
where job.organization_id = task.organization_id
  and job.workspace_id = task.workspace_id
  and job.run_id = task.run_id
  and task.job_id is null;

alter table allrice_managed_browser_tasks
  alter column job_id set not null,
  alter column job_attempt set not null,
  alter column tool_call_id set not null,
  add constraint allrice_browser_task_job_attempt_positive
    check (job_attempt >= 1),
  add constraint allrice_browser_task_job_scope_fk
    foreign key (organization_id, workspace_id, job_id)
    references allrice_jobs(organization_id, workspace_id, id);

create index allrice_browser_tasks_job_attempt
  on allrice_managed_browser_tasks (
    organization_id, workspace_id, job_id, job_attempt, status, id
  );

create unique index allrice_browser_tasks_tool_call_once
  on allrice_managed_browser_tasks (
    organization_id, workspace_id, job_id, job_attempt, tool_call_id
  );

create index allrice_browser_tasks_target_capacity
  on allrice_managed_browser_tasks (
    organization_id, workspace_id, target_id, id
  )
  where status = 'running';

insert into allrice_runtime_metadata (key, value)
values (
  'met98-browser-job-lifecycle',
  '{"version":"0067","issue":"MET-98","binding":"job-attempt-lease","idempotency":"tool-call","recovery":"fail-closed"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
