-- MET-98: every active tenant workspace receives a governed cloud sandbox
-- execution target. Rice Bridge targets are synchronized from bridge heartbeats.

insert into allrice_execution_targets (
  organization_id, workspace_id, target_key, kind, label, state,
  capabilities, concurrency_limit, timeout_seconds, last_heartbeat_at,
  metadata
)
select
  w.organization_id, w.id, 'cloud.default', 'cloud_sandbox',
  'AllRice Cloud Sandbox', 'online',
  '["files.read","files.write","browser.navigate","browser.download","artifacts.write"]'::jsonb,
  4, 900, now(),
  '{"managedBy":"allrice","isolation":"workspace","evidenceRequired":true}'::jsonb
from allrice_workspaces w
where w.archived_at is null
on conflict (organization_id, workspace_id, target_key) do update set
  label = excluded.label,
  capabilities = excluded.capabilities,
  concurrency_limit = excluded.concurrency_limit,
  timeout_seconds = excluded.timeout_seconds,
  metadata = excluded.metadata,
  updated_at = now();

insert into allrice_runtime_metadata (key, value)
values (
  'met98-cloud-targets',
  '{"version":"0059","target":"cloud.default","policy":"workspace-isolated","heartbeat":"platform-managed"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
