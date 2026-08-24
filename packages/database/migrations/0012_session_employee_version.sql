alter table allrice_chat_sessions
  add column employee_version_id uuid;

update allrice_chat_sessions s
set employee_version_id = a.employee_version_id
from allrice_employee_assignments a
where a.id = s.employee_assignment_id
  and a.organization_id = s.organization_id
  and a.workspace_id = s.workspace_id
  and s.employee_version_id is null;

alter table allrice_chat_sessions
  alter column employee_version_id set not null;

alter table allrice_chat_sessions
  add foreign key (organization_id, workspace_id, employee_version_id)
    references allrice_employee_versions(organization_id, workspace_id, id);

create index allrice_sessions_employee_version
  on allrice_chat_sessions (
    organization_id, workspace_id, employee_version_id, updated_at desc
  );

insert into allrice_runtime_metadata (key, value)
values (
  'session-employee-version-schema',
  '{"version":"0012","binding":"session-scoped-employee-version"}'::jsonb
)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
