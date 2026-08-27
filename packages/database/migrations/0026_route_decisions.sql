-- MET-71: replayable, tenant-scoped capability and harness routing decisions.

create table allrice_route_decisions (
  id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  actor_id uuid not null references allrice_users(id),
  employee_id uuid not null,
  run_id uuid not null,
  input_checksum text not null check (input_checksum ~ '^sha256:[a-f0-9]{64}$'),
  candidates jsonb not null check (jsonb_typeof(candidates) = 'array'),
  selected_kind text not null check (selected_kind in (
    'direct', 'knowledge', 'agent_skill', 'workflow', 'tool'
  )),
  selected_candidate_id text not null,
  harness text not null check (harness in ('codex', 'dsh')),
  provider text not null,
  model text not null,
  generation integer not null check (generation >= 0),
  attempt integer not null check (attempt > 0),
  reason_codes jsonb not null check (jsonb_typeof(reason_codes) = 'array'),
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'canceled')),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  cached_input_tokens integer not null default 0 check (cached_input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_cents numeric(14, 6) not null default 0 check (cost_cents >= 0),
  error_code text,
  created_at timestamptz not null,
  completed_at timestamptz,
  foreign key (organization_id, workspace_id)
    references allrice_workspaces(organization_id, id),
  foreign key (organization_id, workspace_id, employee_id)
    references allrice_employees(organization_id, workspace_id, id),
  foreign key (organization_id, workspace_id, run_id)
    references allrice_runs(organization_id, workspace_id, id),
  unique (run_id, attempt),
  unique (organization_id, workspace_id, id)
);

create index allrice_route_decisions_replay
  on allrice_route_decisions (
    organization_id, workspace_id, employee_id, created_at desc
  );

create function allrice_reject_route_decision_core_mutation()
returns trigger language plpgsql as $$
begin
  if
    new.organization_id is distinct from old.organization_id or
    new.workspace_id is distinct from old.workspace_id or
    new.actor_id is distinct from old.actor_id or
    new.employee_id is distinct from old.employee_id or
    new.run_id is distinct from old.run_id or
    new.input_checksum is distinct from old.input_checksum or
    new.candidates is distinct from old.candidates or
    new.selected_kind is distinct from old.selected_kind or
    new.selected_candidate_id is distinct from old.selected_candidate_id or
    new.harness is distinct from old.harness or
    new.provider is distinct from old.provider or
    new.model is distinct from old.model or
    new.generation is distinct from old.generation or
    new.attempt is distinct from old.attempt or
    new.reason_codes is distinct from old.reason_codes or
    new.created_at is distinct from old.created_at
  then
    raise exception 'route decision core is immutable';
  end if;
  return new;
end;
$$;

create trigger allrice_route_decision_core_immutable
before update on allrice_route_decisions
for each row execute function allrice_reject_route_decision_core_mutation();
