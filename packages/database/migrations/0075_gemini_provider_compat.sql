-- MET-115: additive compatibility for the Gemini draft already used on Dev.
-- The previously deployed 0073_gemini_model_provider.sql is archived, not
-- replayed: it disabled unrelated providers and advertised unimplemented OAuth.
-- Preserve all existing IDs, selections, frozen snapshots and credentials.
alter table allrice_model_providers drop constraint if exists allrice_model_providers_auth_mode_check;
alter table allrice_model_providers add constraint allrice_model_providers_auth_mode_check
  check (auth_mode in ('chatgpt_subscription', 'gemini_oauth', 'oauth', 'api_key', 'none'));

-- ID ...0004 was repurposed as Zhipu on Dev. Never rename or overwrite it.
-- No provider is automatically enabled, made ready or approved for production.
insert into allrice_model_providers (id, provider_key, name, harness, auth_mode, enabled)
values ('51000000-0000-4000-8000-000000000005', 'gemini', 'Gemini API', 'dsh', 'api_key', false)
on conflict do nothing;

insert into allrice_model_connections
  (id, provider_id, scope, name, credential_reference, base_url, status, stability, priority)
select '52000000-0000-4000-8000-000000000005', id, 'platform', 'AllRice Gemini API',
  'deployment:gemini-default', null, 'disabled', 'experimental', 50
from allrice_model_providers
where id = '51000000-0000-4000-8000-000000000005' and provider_key = 'gemini' and auth_mode = 'api_key'
on conflict do nothing;

-- The existing governance layer permits a missing release row. Seed an explicit
-- denial, so enabling the catalog alone cannot bypass production/canary review.
insert into allrice_provider_release_controls
  (connection_id, release_stage, allowlisted_organization_ids, production_approved)
select c.id, 'disabled', '{}'::uuid[], false
from allrice_model_connections c join allrice_model_providers p on p.id=c.provider_id
where c.id='52000000-0000-4000-8000-000000000005'
  and p.provider_key='gemini' and p.auth_mode='api_key'
on conflict do nothing;

insert into allrice_model_catalog_entries
  (id, provider_id, model, display_name, context_window_tokens, reasoning_efforts,
   default_reasoning_effort, input_modalities, output_modalities, stability, enabled)
select '53000000-0000-4000-8000-000000000005', id, 'gemini-3.8-flash', 'Gemini 3.8 Flash',
  1048576, '["low","medium","high"]'::jsonb, 'medium', '["text","image"]'::jsonb,
  '["text"]'::jsonb, 'experimental', false
from allrice_model_providers
where id = '51000000-0000-4000-8000-000000000005' and provider_key = 'gemini' and auth_mode = 'api_key'
on conflict do nothing;
