-- A development-test execution can end without deleting its immutable source,
-- journal, account or independent deliverables. This is a terminal lifecycle
-- fact, never a replacement writer or permission to execute a different pack.
create table allrice_native_context_retirements (
  context_kind text not null check (context_kind in
    ('chat','platform_technical','experience_consolidation','platform_employee_test')),
  context_id uuid not null,
  organization_id uuid not null,
  workspace_id uuid not null,
  owner_id uuid not null,
  request_id uuid not null,
  plan_digest text not null check (plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  reason text not null check (reason='development_test_discarded'),
  origin_snapshot jsonb,
  binding_snapshot jsonb not null check (jsonb_typeof(binding_snapshot)='array'),
  preservation_snapshot jsonb not null check (jsonb_typeof(preservation_snapshot)='object'),
  authorization_evidence_digest text not null check
    (authorization_evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  retired_at timestamptz not null default clock_timestamp(),
  primary key(context_kind,context_id)
);
create index allrice_native_context_retirement_request
  on allrice_native_context_retirements(request_id);
create function allrice_native_context_retirement_immutable() returns trigger
language plpgsql as $$
begin raise exception 'native execution retirement is terminal'; end;
$$;
create trigger allrice_native_context_retirement_immutable
  before update or delete on allrice_native_context_retirements
  for each row execute function allrice_native_context_retirement_immutable();

create function allrice_native_binding_reject_retired_context() returns trigger
language plpgsql as $$
begin
  if exists(select 1 from allrice_native_context_retirements r
    where r.context_kind=new.context_kind and r.context_id=new.context_id) then
    raise exception 'native execution context is retired';
  end if;
  return new;
end;
$$;
create trigger allrice_native_binding_reject_retired_context
  before insert on allrice_native_session_bindings for each row
  execute function allrice_native_binding_reject_retired_context();

-- Preserve the cutoff even if a prior application version attempts restore.
create function allrice_native_retired_chat_reject_restore() returns trigger
language plpgsql as $$
begin
  if new.archived_at is null and exists(select 1
    from allrice_native_context_retirements r
    where r.context_kind='chat' and r.context_id=new.id) then
    raise exception 'retired development test chat cannot be restored';
  end if;
  return new;
end;
$$;
create trigger allrice_native_retired_chat_reject_restore
  before update of archived_at on allrice_chat_sessions for each row
  execute function allrice_native_retired_chat_reject_restore();
