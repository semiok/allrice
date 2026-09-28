-- Independent DSH authorization stores; the existing grant remains slot 1.
-- Tokens stay in DSH, never in these account/control-plane tables.
create table allrice_codex_subscriptions (
  slot smallint primary key check (slot in (1, 2)),
  label text not null,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
create unique index allrice_codex_one_enabled
  on allrice_codex_subscriptions ((true)) where enabled;
insert into allrice_codex_subscriptions(slot,label,enabled) values
  (1,'metasnowsky',true), (2,'encorealpha',false);
-- Preserve a pre-existing explicit platform stop.
update allrice_codex_subscriptions set enabled=false where slot=1 and exists(
  select 1 from allrice_provider_circuit_breakers where connection_id='52000000-0000-4000-8000-000000000001' and kill_switch
);

alter table allrice_provider_status
  add column subscription_slot smallint not null default 1 references allrice_codex_subscriptions(slot),
  drop constraint allrice_provider_status_pkey,
  add primary key(provider,subscription_slot);
alter table allrice_provider_authorization_flows
  add column subscription_slot smallint not null default 1 references allrice_codex_subscriptions(slot);
drop index allrice_provider_authorization_one_active;
create unique index allrice_provider_authorization_one_active
  on allrice_provider_authorization_flows(connection_id,subscription_slot)
  where state in ('pending','running','awaiting_user');
alter table allrice_provider_grants
  add column subscription_slot smallint not null default 1 references allrice_codex_subscriptions(slot),
  drop constraint allrice_provider_grants_connection_id_key,
  add unique(connection_id,subscription_slot);
