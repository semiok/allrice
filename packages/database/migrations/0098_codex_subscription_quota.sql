-- Only minimal public quota metadata; no credentials or raw provider payloads.
-- Existing status readers remain compatible. NULL means never measured.
alter table allrice_provider_status
  add column subscription_quota jsonb;

alter table allrice_provider_status add constraint allrice_subscription_quota_object
  check (subscription_quota is null or jsonb_typeof(subscription_quota) = 'object');
