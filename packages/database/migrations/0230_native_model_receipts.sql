-- Private append-only model facts; historical native presentation is untouched.
-- The first Run/route/attempt owns a call, including across later root Runs.
set local lock_timeout = '15s';
create unique index allrice_native_model_receipt_once
  on allrice_run_events (organization_id, workspace_id,
    (payload->>'sourceKey'), (payload->'fact'->>'phase'))
  where event_type='harness.native'
    and payload->>'source'='native_model_receipt_v1';
