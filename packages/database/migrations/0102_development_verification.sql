-- Exact-version verification assignments and append-only review decisions.
-- Contents, process evidence and spending remain in their existing ledgers.
create table allrice_development_verifiers (
  id uuid primary key,
  root_run_id uuid not null references allrice_development_heads(root_run_id),
  run_id uuid not null references allrice_assistant_instances(run_id),
  artifact_id uuid not null references allrice_deliverable_versions(id),
  digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
  role text not null check(role in ('test','review')),
  created_at timestamptz not null default now(),
  unique(root_run_id,run_id,artifact_id,role)
);
create table allrice_development_reviews (
  id uuid primary key,
  root_run_id uuid not null references allrice_development_heads(root_run_id),
  reviewer_run_id uuid not null references allrice_assistant_instances(run_id),
  artifact_id uuid not null references allrice_deliverable_versions(id),
  digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
  operation_id uuid not null references allrice_runtime_operations(id),
  verdict text not null check(verdict in ('accept','revise')),
  summary text not null check(length(summary) between 1 and 16000),
  created_at timestamptz not null default now()
);
create index allrice_development_reviews_version on allrice_development_reviews(root_run_id,artifact_id,created_at);
create table allrice_development_deliveries (
  artifact_id uuid primary key references allrice_deliverable_versions(id),
  root_run_id uuid not null references allrice_development_heads(root_run_id),
  candidate_id uuid not null references allrice_deliverable_versions(id),
  digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
  review_id uuid not null references allrice_development_reviews(id),
  created_at timestamptz not null default now()
);
create index allrice_development_deliveries_candidate on allrice_development_deliveries(root_run_id,candidate_id);
create trigger allrice_development_delivery_immutable before update on allrice_development_deliveries
  for each row execute function allrice_guard_development_record();
create trigger allrice_development_verifier_immutable before update on allrice_development_verifiers
  for each row execute function allrice_guard_development_record();
create trigger allrice_development_review_immutable before update on allrice_development_reviews
  for each row execute function allrice_guard_development_record();
