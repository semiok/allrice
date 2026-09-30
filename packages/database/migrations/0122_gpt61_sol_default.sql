-- GPT-6.1 Sol is the platform work-model default for future Runs. Preserve
-- reasoning, images, authorization, and all historical execution snapshots.
insert into allrice_model_catalog_entries (
  id, provider_id, model, display_name, context_window_tokens, reasoning_efforts,
  default_reasoning_effort, input_modalities, output_modalities, enabled, stability
)
select gen_random_uuid(), p.id, 'gpt-6.1-sol', 'GPT-6.1 Sol', 272000,
  '["low","medium","high","xhigh"]'::jsonb, 'xhigh',
  '["text","image"]'::jsonb, '["text"]'::jsonb, true, 'production'
from allrice_model_providers p
where p.provider_key in ('codex','openai-codex') and p.auth_mode='chatgpt_subscription'
on conflict (provider_id,model) do nothing;

update allrice_platform_model_settings
set configuration=jsonb_set(configuration,'{workModel}','"gpt-6.1-sol"'::jsonb),
    revision=revision+1, updated_at=now()
where singleton and configuration->>'workModel' is distinct from 'gpt-6.1-sol';
