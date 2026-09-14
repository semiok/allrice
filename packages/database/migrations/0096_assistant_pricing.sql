-- Additive evidence only: no backfill, existing NULL costs remain unknown.
-- Trusted worker APIs freeze a configured tariff before any model admission.
create table allrice_assistant_price_snapshots (
  root_run_id uuid primary key references allrice_assistant_roots(root_run_id),
  snapshot_digest text not null check (snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  snapshot jsonb not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  frozen_at timestamptz not null default clock_timestamp(),
  unique (root_run_id, snapshot_digest)
);
create table allrice_assistant_cost_receipts (
  call_id uuid primary key references allrice_assistant_model_admissions(call_id),
  root_run_id uuid not null,
  run_id uuid not null references allrice_assistant_instances(run_id),
  snapshot_digest text not null,
  request_digest text not null check (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  receipt_digest text not null check (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  usage jsonb not null,
  usage_complete boolean not null,
  cache_usage_known boolean not null,
  cost_basis text not null check (cost_basis in ('unknown','conservative_upper_bound')),
  actual_cost_known boolean not null default false check (actual_cost_known=false),
  cost_picounits numeric(40,0) check (cost_picounits >= 0),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (root_run_id, snapshot_digest) references allrice_assistant_price_snapshots(root_run_id, snapshot_digest),
  check (cache_usage_known=false),
  check ((cost_picounits is not null) = usage_complete),
  check ((cost_basis='conservative_upper_bound') = usage_complete)
);
create index allrice_assistant_cost_receipts_root on allrice_assistant_cost_receipts(root_run_id, run_id);

-- Replay/recovery must not overwrite evidence or reinterpret an old tariff.
-- DDL DROP of an isolated fixture schema is unaffected by row-level triggers.
create function allrice_reject_assistant_pricing_mutation() returns trigger
language plpgsql as $$
begin
  raise exception using errcode='55000', message='ASSISTANT_PRICING_IMMUTABLE';
end;
$$;
create trigger allrice_assistant_price_snapshots_immutable
  before update or delete on allrice_assistant_price_snapshots
  for each row execute function allrice_reject_assistant_pricing_mutation();
create trigger allrice_assistant_cost_receipts_immutable
  before update or delete on allrice_assistant_cost_receipts
  for each row execute function allrice_reject_assistant_pricing_mutation();
