-- P06 is a projection of existing immutable deliverable versions, not a new object store.
create table allrice_workbench_artifacts (
  version_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null references allrice_users(id),
  run_id uuid not null,
  kind text not null check(kind in ('document','plan','changeset','command_output','browser_capture','file')),
  provenance jsonb not null,
  execution jsonb,
  request_id text not null check(char_length(request_id) between 1 and 255),
  request_digest text not null check(request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  foreign key(organization_id,workspace_id,version_id) references allrice_deliverable_versions(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,run_id) references allrice_runs(organization_id,workspace_id,id),
  unique(organization_id,workspace_id,run_id,request_id)
);
create function allrice_workbench_artifact_immutable() returns trigger language plpgsql as $$
begin raise exception 'artifact version metadata is immutable'; end; $$;
create trigger allrice_workbench_artifact_immutable before update or delete on allrice_workbench_artifacts
  for each row execute function allrice_workbench_artifact_immutable();

create table allrice_artifact_feedback (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  actor_id uuid not null references allrice_users(id),
  artifact_id uuid not null,
  checksum text not null check(checksum ~ '^sha256:[a-f0-9]{64}$'),
  revision integer not null check(revision>0),
  comments jsonb not null check(jsonb_typeof(comments)='array' and jsonb_array_length(comments) between 1 and 20),
  state text not null check(state in ('draft','submitted','addressed')),
  result_artifact_id uuid,
  resolution text check(char_length(resolution)<=4000),
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key(organization_id,workspace_id,artifact_id) references allrice_deliverable_versions(organization_id,workspace_id,id),
  foreign key(organization_id,workspace_id,result_artifact_id) references allrice_deliverable_versions(organization_id,workspace_id,id),
  check((state='draft')=(submitted_at is null)),
  check((state='addressed')=(result_artifact_id is not null)),
  check((result_artifact_id is null)=(resolution is null))
);
create index allrice_artifact_feedback_scope on allrice_artifact_feedback(organization_id,workspace_id,artifact_id,created_at);
create function allrice_artifact_feedback_guard() returns trigger language plpgsql as $$
begin
  if new.id<>old.id or new.organization_id<>old.organization_id or new.workspace_id<>old.workspace_id or new.actor_id<>old.actor_id
    or new.artifact_id<>old.artifact_id or new.checksum<>old.checksum or new.created_at<>old.created_at then
    raise exception 'review identity is immutable';
  end if;
  if old.state<>'draft' and (new.comments is distinct from old.comments or new.revision<>old.revision or new.submitted_at is distinct from old.submitted_at)
    then raise exception 'submitted review body is immutable'; end if;
  if old.state='addressed' and new is distinct from old then raise exception 'review response is immutable'; end if;
  if old.state='submitted' and new.state not in ('submitted','addressed') then raise exception 'cannot unsubmit feedback'; end if;
  return new;
end; $$;
create trigger allrice_artifact_feedback_guard before update on allrice_artifact_feedback for each row execute function allrice_artifact_feedback_guard();
