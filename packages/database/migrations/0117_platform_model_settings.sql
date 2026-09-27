-- MET-163. Platform defaults apply when a new Run is bound. Historical Run
-- snapshots, employee revisions and provider receipts are never rewritten.
create table allrice_platform_model_settings (
  singleton boolean primary key default true check (singleton),
  revision integer not null default 1 check (revision > 0),
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  updated_by uuid references allrice_users(id),
  updated_at timestamptz not null default now()
);

insert into allrice_platform_model_settings(configuration)
values ('{"connectionId":"52000000-0000-4000-8000-000000000001","workModel":"gpt-5.6-luna","reasoningEffort":"xhigh","timeoutMs":300000,"imageModel":"gpt-image-2.5-flare","imagesEnabled":false}'::jsonb);

-- Keep the catalog/connection rows for historical foreign keys and accounting.
update allrice_model_providers set enabled=false, updated_at=now()
where provider_key in ('gemini','google') or auth_mode='gemini_oauth';
update allrice_model_catalog_entries set enabled=false, updated_at=now()
where provider_id in (select id from allrice_model_providers
  where provider_key in ('gemini','google') or auth_mode='gemini_oauth');
update allrice_model_connections set status='disabled', updated_at=now()
where provider_id in (select id from allrice_model_providers
  where provider_key in ('gemini','google') or auth_mode='gemini_oauth');
