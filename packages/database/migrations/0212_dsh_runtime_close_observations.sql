-- Provisional number: B2a's 0211 must be reconciled before integration.
-- Evidence only. This table never owns stopping, grants execution, marks a
-- producer finished, deletes history, or retires an artifact.
create table allrice_dsh_runtime_close_observations (
  runtime_id uuid not null,
  worker_boot_id uuid not null,
  observation_kind text not null check (observation_kind in
    ('owned','close_started','close_request','process_closed')),
  owner_kind text not null default 'owned' check (owner_kind='owned'),
  owner_digest text not null check (owner_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload_digest text not null check (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload)='object'
    and payload ?& array['version','kind','runtimeId','workerBootId','observedAt']
    and jsonb_typeof(payload->'observedAt')='string'
    and payload->>'version'='1'
    and payload->>'kind'=observation_kind
    and (payload->>'runtimeId')::uuid=runtime_id
    and (payload->>'workerBootId')::uuid=worker_boot_id
    and octet_length(payload::text) <= 4096),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (runtime_id,worker_boot_id,observation_kind),
  unique (runtime_id,worker_boot_id,observation_kind,payload_digest),
  check (observation_kind<>'owned' or owner_digest=payload_digest),
  foreign key (runtime_id,worker_boot_id,owner_kind,owner_digest)
    references allrice_dsh_runtime_close_observations
      (runtime_id,worker_boot_id,observation_kind,payload_digest)
);
create index allrice_dsh_close_artifact on allrice_dsh_runtime_close_observations
  ((payload->>'artifactId')) where observation_kind='owned';
create index allrice_dsh_close_context on allrice_dsh_runtime_close_observations
  ((payload->'context'->>'contextKind'),(payload->'context'->>'contextId'))
  where observation_kind='owned';
create function allrice_dsh_close_evidence_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'DSH_CLOSE_EVIDENCE_IMMUTABLE';
end $$;
create trigger allrice_dsh_close_evidence_immutable
  before update or delete on allrice_dsh_runtime_close_observations
  for each row execute function allrice_dsh_close_evidence_immutable();
