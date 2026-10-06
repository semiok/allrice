-- Platform adaptation stores facts, not a second task state machine. Local
-- Changeset execution and operation_id constraints remain unchanged.
create table allrice_platform_repository_review_subjects (
  id uuid primary key,
  publication_id uuid not null references allrice_platform_repository_publications(id),
  owner_id uuid not null references allrice_users(id),
  organization_id uuid not null references allrice_organizations(id),
  workspace_id uuid not null references allrice_workspaces(id),
  request_id uuid not null,
  input_digest text not null check(input_digest ~ '^sha256:[a-f0-9]{64}$'),
  run_id uuid not null unique references allrice_runs(id),
  job_id uuid not null unique references allrice_jobs(id),
  session_id uuid not null references allrice_chat_sessions(id),
  frozen jsonb not null,
  subject_digest text not null check(subject_digest ~ '^sha256:[a-f0-9]{64}$'),
  content_digest text not null check(content_digest ~ '^sha256:[a-f0-9]{64}$'),
  seed_artifact_id uuid unique references allrice_deliverable_versions(id),
  reviewer_run_id uuid unique references allrice_assistant_instances(run_id),
  delivery_artifact_id uuid unique references allrice_deliverable_versions(id),
  preflight jsonb,
  postflight jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(owner_id,request_id)
);
create index on allrice_platform_repository_review_subjects(owner_id,publication_id,created_at desc);
create index on allrice_platform_repository_review_subjects(owner_id,content_digest);
create table allrice_platform_repository_reviews (
  id uuid primary key,
  subject_id uuid not null unique references allrice_platform_repository_review_subjects(id),
  reviewer_run_id uuid not null references allrice_assistant_instances(run_id),
  request_digest text not null check(request_digest ~ '^sha256:[a-f0-9]{64}$'),
  verdict text not null check(verdict in ('accept','revise')),
  summary text not null check(length(summary) between 1 and 16000),
  evidence_digest text not null check(evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  artifact_id uuid not null unique references allrice_deliverable_versions(id),
  created_at timestamptz not null default clock_timestamp()
);
create function allrice_repository_review_subject_immutable() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-array['seed_artifact_id','reviewer_run_id','delivery_artifact_id','preflight','postflight']) is distinct from (to_jsonb(old)-array['seed_artifact_id','reviewer_run_id','delivery_artifact_id','preflight','postflight'])
    or (old.seed_artifact_id is not null and new.seed_artifact_id is distinct from old.seed_artifact_id)
    or (old.reviewer_run_id is not null and new.reviewer_run_id is distinct from old.reviewer_run_id)
    or (old.delivery_artifact_id is not null and new.delivery_artifact_id is distinct from old.delivery_artifact_id)
    or (old.preflight is not null and new.preflight is distinct from old.preflight)
    or (old.postflight is not null and new.postflight is distinct from old.postflight)
  then raise exception 'repository review subject is immutable'; end if;
  return new;
end $$;
create trigger allrice_repository_review_subject_immutable before update on allrice_platform_repository_review_subjects for each row execute function allrice_repository_review_subject_immutable();
create trigger allrice_repository_review_immutable before update or delete on allrice_platform_repository_reviews for each row execute function allrice_guard_development_record();
