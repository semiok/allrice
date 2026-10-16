-- Evidence stays in the existing memory/review lifecycle. It is not an
-- effective instruction and cannot enter recall before controlled adoption.
alter table allrice_memories add column instance_id uuid;
alter table allrice_memories add foreign key
  (organization_id,workspace_id,owner_id,instance_id)
  references allrice_employee_instances(organization_id,workspace_id,owner_id,id);

alter table allrice_experience_reviews
  add column origin_kind text not null default 'manual'
    check (origin_kind in ('manual','incremental')),
  add column instance_id uuid,
  add column source_key text,
  add column evidence jsonb;
alter table allrice_experience_reviews add foreign key
  (organization_id,workspace_id,owner_id,instance_id)
  references allrice_employee_instances(organization_id,workspace_id,owner_id,id);
alter table allrice_experience_reviews add check (
  (origin_kind='manual' and instance_id is null and source_key is null and evidence is null)
  or (origin_kind='incremental' and instance_id is not null
    and source_key is not null and source_key ~ '^sha256:[a-f0-9]{64}$'
    and evidence is not null and jsonb_typeof(evidence)='object'
    and requested_scope='private' and not share_acknowledged)
);
-- Includes withdrawn/forgotten rows. A new policy or summarizer cannot revive
-- the same source. The existing immutable-origin trigger protects these fields.
create unique index allrice_experience_source_identity
  on allrice_experience_reviews(organization_id,workspace_id,owner_id,instance_id,source_key)
  where origin_kind='incremental';

alter table allrice_employee_runs
  add column experience_capture_state text
    check (experience_capture_state in ('pending','captured','ignored')),
  add column experience_capture_reason text,
  add column experience_captured_at timestamptz;
create index allrice_experience_pending_runs
  on allrice_employee_runs(completed_at,run_id)
  where experience_capture_state='pending';

-- An explicit initial watermark, separate from future consolidation cursors.
-- No historical Run is marked pending by this migration.
insert into allrice_settings(scope_type,scope_id,key,value)
values('system',null,'employee_experience_policy',jsonb_build_object(
  'schemaVersion',1,'revision',1,'frequency','weekly',
  'collectionStartedAt',to_char(clock_timestamp() at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'authorizationSource','platform_automatic_experience_policy'
)) on conflict(scope_type,scope_id,key) do nothing;
