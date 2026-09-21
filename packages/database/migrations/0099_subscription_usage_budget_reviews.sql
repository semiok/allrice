-- Administrator risk acceptance, NOT a replacement for actual provider usage.
-- Original route/ledger unknown values and original accounting month stay intact.
create table allrice_subscription_usage_budget_reviews (
  route_decision_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  reserved_tokens bigint not null check (reserved_tokens > 0 and reserved_tokens <= 10000000000),
  ledger_snapshot jsonb not null check (jsonb_typeof(ledger_snapshot) = 'object'),
  reason text not null check (length(reason) between 10 and 2000),
  approved_by uuid not null references allrice_users(id),
  request_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, workspace_id, route_decision_id)
    references allrice_route_decisions(organization_id, workspace_id, id),
  foreign key (route_decision_id)
    references allrice_route_subscription_snapshots(route_decision_id)
);

create function allrice_reject_usage_budget_review_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'subscription usage budget review is immutable';
end;
$$;
create trigger allrice_usage_budget_review_immutable
before update or delete on allrice_subscription_usage_budget_reviews
for each row execute function allrice_reject_usage_budget_review_mutation();
