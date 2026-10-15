-- Preserve the original timeout/cancel fact while accepting a delayed receipt
-- from the exact already-claimed command. No new admission or execution lease.
ALTER TABLE allrice_bridge_commands
  ADD COLUMN IF NOT EXISTS late_receipt jsonb,
  ADD COLUMN IF NOT EXISTS late_receipt_at timestamptz;

ALTER TABLE allrice_bridge_workspace_selection_requests
  ADD COLUMN IF NOT EXISTS late_receipt jsonb,
  ADD COLUMN IF NOT EXISTS late_receipt_at timestamptz;
