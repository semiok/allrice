-- Reuse Memory revisions and the private experience origin, with an explicit
-- machine policy proof. Do not mislabel automatic adoption as human review.
alter table allrice_experience_reviews
  drop constraint allrice_experience_reviews_origin_kind_check,
  drop constraint allrice_experience_reviews_check1,
  drop constraint allrice_experience_reviews_check2,
  add column adoption_proof jsonb,
  add constraint allrice_experience_origin_kind check (origin_kind in ('manual','incremental','derived')),
  add constraint allrice_experience_origin_fields check (
    (origin_kind='manual' and instance_id is null and source_key is null and evidence is null and adoption_proof is null)
    or (origin_kind='incremental' and instance_id is not null and source_key ~ '^sha256:[a-f0-9]{64}$'
      and evidence is not null and jsonb_typeof(evidence)='object' and adoption_proof is null
      and requested_scope='private' and not share_acknowledged)
    or (origin_kind='derived' and instance_id is not null and source_key ~ '^sha256:[a-f0-9]{64}$'
      and evidence is null and adoption_proof is not null and jsonb_typeof(adoption_proof)='object'
      and adoption_proof->>'schemaVersion'='1' and requested_scope='private' and not share_acknowledged)
  ),
  add constraint allrice_experience_review_authority check (
    (origin_kind='derived' and status='approved' and reviewed_by is null and reviewed_at is not null and length(review_reason) between 1 and 500)
    or (origin_kind<>'derived' and (
      (status='pending' and reviewed_by is null and reviewed_at is null and review_reason is null)
      or (status<>'pending' and reviewed_by is not null and reviewed_at is not null and length(review_reason) between 1 and 500)))
  );
-- Tombstones remain unique: retrying a tick or re-enabling the policy cannot
-- resurrect an adopted/forgotten draft or the same finite rule family.
create unique index allrice_experience_adoption_once on allrice_experience_reviews
  (organization_id,workspace_id,owner_id,instance_id,(adoption_proof->>'occurrenceId'),(adoption_proof->>'draftIndex')) where origin_kind='derived';
create unique index allrice_experience_rule_once on allrice_experience_reviews
  (organization_id,workspace_id,owner_id,instance_id,source_key) where origin_kind='derived';
alter table allrice_automation_runs add column experience_adoption_plan jsonb;
alter table allrice_employee_runs
  add column experience_reads jsonb not null default '[]'::jsonb check (jsonb_typeof(experience_reads)='array' and jsonb_array_length(experience_reads)<=20),
  add column experience_prepared_at timestamptz,
  add column experience_action_receipt jsonb;
