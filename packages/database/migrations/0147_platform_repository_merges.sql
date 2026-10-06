-- Exact external side-effect facts use canonical Run/Job state and leases.
create table allrice_platform_repository_merges (
  id uuid primary key,
  publication_id uuid not null references allrice_platform_repository_publications(id),
  review_subject_id uuid not null references allrice_platform_repository_review_subjects(id),
  owner_id uuid not null references allrice_users(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  review jsonb not null,
  review_digest text not null check(review_digest ~ '^sha256:[a-f0-9]{64}$'),
  ready_intent jsonb,
  merge_intent jsonb,
  receipt jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(publication_id,review_digest)
);
create table allrice_platform_repository_merge_actions (
  id uuid primary key,
  merge_id uuid not null references allrice_platform_repository_merges(id),
  owner_id uuid not null references allrice_users(id),
  request_id uuid not null,
  request jsonb not null,
  input_digest text not null check(input_digest ~ '^sha256:[a-f0-9]{64}$'),
  login_session_id uuid not null references allrice_sessions(id),
  login_authenticated_at timestamptz not null,
  credential_revision integer not null check(credential_revision>0),
  run_id uuid not null unique references allrice_runs(id),
  job_id uuid not null unique references allrice_jobs(id),
  completion jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(owner_id,request_id)
);
create function allrice_repository_merge_immutable() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-array['ready_intent','merge_intent','receipt']) is distinct from (to_jsonb(old)-array['ready_intent','merge_intent','receipt'])
    or (old.ready_intent is not null and new.ready_intent is distinct from old.ready_intent)
    or (old.merge_intent is not null and new.merge_intent is distinct from old.merge_intent)
    or (old.receipt is not null and new.receipt is distinct from old.receipt)
  then raise exception 'repository merge is immutable'; end if;
  return new;
end $$;
create trigger allrice_repository_merge_immutable before update on allrice_platform_repository_merges for each row execute function allrice_repository_merge_immutable();
create function allrice_repository_merge_action_immutable() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-'completion') is distinct from (to_jsonb(old)-'completion')
    or (old.completion is not null and new.completion is distinct from old.completion)
  then raise exception 'repository merge action is immutable'; end if;
  return new;
end $$;
create trigger allrice_repository_merge_action_immutable before update on allrice_platform_repository_merge_actions for each row execute function allrice_repository_merge_action_immutable();

create trigger allrice_repository_merge_no_delete before delete on allrice_platform_repository_merges
  for each row execute function allrice_guard_development_record();
create trigger allrice_repository_merge_action_no_delete before delete on allrice_platform_repository_merge_actions
  for each row execute function allrice_guard_development_record();
