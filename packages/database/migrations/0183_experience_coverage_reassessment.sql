-- Append an exact, versioned coverage decision. Original draft/plan/test results
-- stay immutable; a draft with any previous test is never retried here.
create table allrice_experience_coverage_reassessments (
  occurrence_id uuid not null references allrice_automation_runs(id),
  draft_index integer not null check (draft_index between 0 and 7),
  recognizer_version text not null,
  prior_plan_digest text not null check (prior_plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  output_digest text not null check (output_digest ~ '^sha256:[a-f0-9]{64}$'),
  draft_digest text not null check (draft_digest ~ '^sha256:[a-f0-9]{64}$'),
  test_id uuid unique references allrice_platform_employee_test_runs(id),
  reason text,
  created_at timestamptz not null default clock_timestamp(),
  primary key (occurrence_id, draft_index, recognizer_version),
  check ((test_id is not null and reason is null) or (test_id is null and reason is not null))
);
create function allrice_experience_reassessment_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'experience coverage reassessment is append-only';
end $$;
create trigger allrice_experience_reassessment_guard before update or delete
  on allrice_experience_coverage_reassessments for each row
  execute function allrice_experience_reassessment_immutable();
