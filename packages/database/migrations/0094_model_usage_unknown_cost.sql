-- P25 additive accounting truth: unavailable estimates are not zero cost.
-- Keep historical values unchanged; legacy numeric writers remain compatible.
-- Downgrade only to a reader that preserves NULL and completeness metadata.
alter table allrice_route_decisions
  alter column cost_cents drop not null,
  add column cache_usage_known boolean not null default true,
  add column usage_complete boolean not null default true;

alter table allrice_model_usage_ledger
  alter column cost_cents drop not null,
  add column cache_usage_known boolean not null default true,
  add column usage_complete boolean not null default true;
