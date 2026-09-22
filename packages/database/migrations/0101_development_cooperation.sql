-- MET-144 X01-A: proposal coordination only. No new execution grant, queue,
-- budget, content store or model tool. Existing artifact IDs remain versions.
create table allrice_development_heads (
  root_run_id uuid primary key references allrice_assistant_roots(root_run_id),
  seed_artifact_id uuid not null references allrice_deliverable_versions(id),
  seed_digest text not null check(seed_digest ~ '^sha256:[a-f0-9]{64}$'),
  head_artifact_id uuid not null references allrice_deliverable_versions(id),
  head_digest text not null check(head_digest ~ '^sha256:[a-f0-9]{64}$'),
  execution jsonb not null,
  revision integer not null default 0 check(revision >= 0),
  created_at timestamptz not null default now()
);
create table allrice_development_assignments (
  id uuid primary key,
  root_run_id uuid not null references allrice_development_heads(root_run_id),
  run_id uuid not null references allrice_assistant_instances(run_id),
  assigned_by_run_id uuid not null references allrice_assistant_instances(run_id),
  base_artifact_id uuid not null references allrice_deliverable_versions(id),
  base_digest text not null check(base_digest ~ '^sha256:[a-f0-9]{64}$'),
  execution jsonb not null,
  paths jsonb not null check(jsonb_typeof(paths)='array' and jsonb_array_length(paths) between 1 and 32),
  request_digest text not null,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique(root_run_id,id)
);
create index allrice_development_assignments_root on allrice_development_assignments(root_run_id);
create table allrice_development_proposals (
  artifact_id uuid primary key references allrice_deliverable_versions(id),
  root_run_id uuid not null,
  assignment_id uuid not null,
  digest text not null check(digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  foreign key(root_run_id,assignment_id) references allrice_development_assignments(root_run_id,id)
);
create table allrice_development_merges (
  request_id uuid primary key,
  root_run_id uuid not null references allrice_development_heads(root_run_id),
  request_digest text not null,
  previous_artifact_id uuid not null references allrice_deliverable_versions(id),
  result_artifact_id uuid not null unique references allrice_deliverable_versions(id),
  result_digest text not null check(result_digest ~ '^sha256:[a-f0-9]{64}$'),
  revision integer not null check(revision > 0),
  created_at timestamptz not null default now(),
  unique(root_run_id,revision)
);
create table allrice_development_merge_sources (
  request_id uuid not null references allrice_development_merges(request_id),
  artifact_id uuid primary key references allrice_development_proposals(artifact_id)
);

-- Immutable input/provenance records. Closing a proposal claim does not prove
-- its physical process stopped; physical execution remains the operation ledger.
create function allrice_guard_development_assignment() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-'released_at') is distinct from (to_jsonb(old)-'released_at')
    or (old.released_at is not null and new.released_at is distinct from old.released_at) then
    raise exception 'development assignment is immutable';
  end if;
  return new;
end $$;
create trigger allrice_development_assignment_immutable before update on allrice_development_assignments
  for each row execute function allrice_guard_development_assignment();
create function allrice_guard_development_record() returns trigger language plpgsql as $$
begin
  if new is distinct from old then raise exception 'development version provenance is immutable'; end if;
  return new;
end $$;
create trigger allrice_development_proposal_immutable before update on allrice_development_proposals
  for each row execute function allrice_guard_development_record();
create trigger allrice_development_merge_immutable before update on allrice_development_merges
  for each row execute function allrice_guard_development_record();
create trigger allrice_development_source_immutable before update on allrice_development_merge_sources
  for each row execute function allrice_guard_development_record();
create function allrice_guard_development_head() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new)-array['head_artifact_id','head_digest','revision']) is distinct from
     (to_jsonb(old)-array['head_artifact_id','head_digest','revision'])
    or new.revision <> old.revision + 1
    or not exists(select 1 from allrice_development_merges m where m.root_run_id=old.root_run_id
      and m.previous_artifact_id=old.head_artifact_id and m.result_artifact_id=new.head_artifact_id
      and m.result_digest=new.head_digest and m.revision=new.revision) then
    raise exception 'development head requires a verified merge record';
  end if;
  return new;
end $$;
create trigger allrice_development_head_guard before update on allrice_development_heads
  for each row execute function allrice_guard_development_head();
