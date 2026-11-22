-- Module-owned schema. Apply explicitly during the authorized batch migration;
-- importing or constructing the gateway never runs DDL against shared Dev.
CREATE TABLE allrice_outbound_approvals (
  request_id uuid PRIMARY KEY,
  scope_key text NOT NULL,
  idempotency_key text NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (scope_key, idempotency_key),
  CHECK (record->'ref'->>'requestId' = request_id::text),
  CHECK (record->>'scopeKey' = scope_key),
  CHECK (record->>'idempotencyKey' = idempotency_key)
);
