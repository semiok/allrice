create table allrice_member_work_automation (
  organization_id uuid not null references allrice_organizations(id) on delete cascade,
  workspace_id uuid not null references allrice_workspaces(id) on delete cascade,
  user_id uuid not null references allrice_users(id) on delete cascade,
  revision integer not null check (revision > 0),
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (organization_id, workspace_id, user_id)
);

-- An admitted operation keeps its confirmation choice; changing a preference
-- governs subsequent operations, not a replay or retroactive approval.
alter table allrice_runtime_operations add column member_automation jsonb;
create function allrice_guard_operation_member_automation() returns trigger language plpgsql as $$
begin
  if old.member_automation is not null and new.member_automation is distinct from old.member_automation then
    raise exception 'operation member automation is immutable';
  end if;
  return new;
end;
$$;
create trigger allrice_operation_member_automation_immutable before update on allrice_runtime_operations
  for each row execute function allrice_guard_operation_member_automation();
