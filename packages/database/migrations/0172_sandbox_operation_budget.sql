-- Extend the existing operation ledger; no second task/attempt identity.
-- Queue time is excluded: this is initialized only after physical admission.
alter table allrice_runtime_operations add column execution_budget jsonb
  check (execution_budget is null or (jsonb_typeof(execution_budget)='object' and execution_budget->>'version'='1'));
