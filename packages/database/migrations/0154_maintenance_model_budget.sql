-- Reuse the native call ledger. Unknown provider usage retains its full
-- reservation; process restarts cannot replenish a maintenance grant.
alter table allrice_task_calls add column reserved_output_tokens integer check(reserved_output_tokens>0);
alter table allrice_task_calls add column settled_output_tokens integer check(settled_output_tokens>=0);
alter table allrice_task_calls add column model_request_digest text;
alter table allrice_task_calls add column model_dispatched_at timestamptz;
