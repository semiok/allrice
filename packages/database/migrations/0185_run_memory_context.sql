-- Derived accounting only; memories, revisions and source proofs stay authoritative.
-- NULL preserves old Run records; only newly inserted Runs may initialize a budget.
alter table allrice_employee_runs
  add column memory_context_state jsonb;
-- Old Runs retain NULL: their prior disclosures are unknown, never reset to 0.
alter table allrice_employee_runs alter column memory_context_state
  set default '{"schemaVersion":1,"pending":true}'::jsonb;
