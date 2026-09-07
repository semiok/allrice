-- Proposal/approval/application are distinct. The existing Run and operation ledger
-- remain authoritative; this immutable association is not another execution queue.
create table allrice_changeset_runs (
  run_id uuid primary key references allrice_runs(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  session_id uuid not null references allrice_chat_sessions(id),
  actor_id uuid not null references allrice_users(id),
  artifact_id uuid not null references allrice_deliverable_versions(id),
  checksum text not null check(checksum ~ '^sha256:[a-f0-9]{64}$'),
  restore_of uuid references allrice_changeset_runs(run_id),
  created_at timestamptz not null default now()
);
create unique index allrice_changeset_apply_once on allrice_changeset_runs(artifact_id, actor_id) where restore_of is null;
create unique index allrice_changeset_restore_once on allrice_changeset_runs(restore_of) where restore_of is not null;
create index allrice_changeset_session on allrice_changeset_runs(organization_id,workspace_id,session_id,created_at);
create trigger allrice_changeset_run_immutable before update or delete on allrice_changeset_runs for each row execute function allrice_workbench_artifact_immutable();

alter table allrice_chat_input_requests drop constraint allrice_chat_input_requests_kind_check;
alter table allrice_chat_input_requests add constraint allrice_chat_input_requests_kind_check check (kind in ('message','steer_current','queue_next','ask_user','plan_review','version_feedback','changeset_request'));
