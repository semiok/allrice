-- MET-268: host-only metering facts + admission leases. No Agent/Run state.
-- An intent is durable BEFORE fetch; it never proves upstream receipt or cost.
create table allrice_model_gateway_calls (
  id uuid primary key,
  native_key text not null unique,
  person_id uuid not null,
  organization_id uuid not null,
  binding jsonb not null,
  request_digest text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index allrice_model_gateway_calls_usage
  on allrice_model_gateway_calls(person_id, organization_id, created_at);

create table allrice_model_gateway_attempts (
  id uuid primary key,
  call_id uuid not null references allrice_model_gateway_calls(id),
  person_id uuid not null,
  owner_id text not null,
  kind text not null check (kind in ('model', 'auth-refresh')),
  protocol text not null check (protocol in ('openai-chat-completions', 'openai-responses', 'opaque')),
  intent_at timestamptz not null default clock_timestamp(),
  receipt jsonb,
  closed_at timestamptz,
  recovery_evidence_ref text,
  check ((receipt is null) = (closed_at is null))
);
create index allrice_model_gateway_attempts_call on allrice_model_gateway_attempts(call_id, intent_at);
create index allrice_model_gateway_attempts_owner on allrice_model_gateway_attempts(owner_id)
  where closed_at is null;

-- person_id is GLOBAL, deliberately without organization_id in the key.
-- No TTL: an unknown/crashed transport must not release an active stream slot.
create table allrice_model_gateway_slots (
  person_id uuid not null,
  slot smallint not null check (slot between 1 and 8),
  attempt_id uuid not null unique references allrice_model_gateway_attempts(id),
  owner_id text not null,
  acquired_at timestamptz not null default clock_timestamp(),
  primary key (person_id, slot)
);

create function allrice_model_gateway_immutable() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'allrice_model_gateway_calls' then
    raise exception 'model gateway call identity is immutable';
  end if;
  if row(new.id, new.call_id, new.person_id, new.owner_id, new.kind, new.protocol, new.intent_at)
    is distinct from row(old.id, old.call_id, old.person_id, old.owner_id, old.kind, old.protocol, old.intent_at)
    or (old.receipt is not null and row(new.receipt, new.closed_at, new.recovery_evidence_ref)
      is distinct from row(old.receipt, old.closed_at, old.recovery_evidence_ref)) then
    raise exception 'model gateway attempt facts are immutable';
  end if;
  return new;
end;
$$;
create trigger allrice_model_gateway_calls_immutable before update on allrice_model_gateway_calls
  for each row execute function allrice_model_gateway_immutable();
create trigger allrice_model_gateway_attempts_immutable before update on allrice_model_gateway_attempts
  for each row execute function allrice_model_gateway_immutable();
