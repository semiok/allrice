-- Expand only. No historical route or usage value is rewritten/reclassified.
-- Only new, pre-execution, server-verified proofs make NULL cost not applicable.
create table allrice_route_subscription_snapshots (
  route_decision_id uuid primary key references allrice_route_decisions(id),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_digest text not null check (snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  frozen_at timestamptz not null default clock_timestamp(),
  check (snapshot @> '{"version":1,"billingMode":"subscription","harness":"dsh","provider":"openai-codex","authMode":"chatgpt_subscription","baseUrl":null}'::jsonb)
);
create trigger allrice_route_subscription_snapshots_immutable
  before update or delete on allrice_route_subscription_snapshots
  for each row execute function allrice_reject_assistant_pricing_mutation();
