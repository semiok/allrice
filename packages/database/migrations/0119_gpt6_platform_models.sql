-- Replace the selectable work models without rewriting historical Run snapshots.
insert into allrice_model_catalog_entries (
  id, provider_id, model, display_name, context_window_tokens, reasoning_efforts,
  default_reasoning_effort, input_modalities, output_modalities, enabled, stability
)
select gen_random_uuid(), p.id, m.model, m.label, 272000,
  '["low","medium","high","xhigh"]'::jsonb, 'xhigh',
  '["text","image","file"]'::jsonb, '["text"]'::jsonb, true, 'production'
from allrice_model_providers p
cross join (values ('gpt-6-sol', 'GPT-6 Sol'), ('gpt-6-luna', 'GPT-6 Luna')) m(model,label)
where p.provider_key in ('codex','openai-codex') and p.auth_mode='chatgpt_subscription'
on conflict (provider_id,model) do nothing;

-- Default retired selections to GPT-6 Luna / xhigh. Keep connection, images,
-- timeout and an explicitly selected Spark unchanged.
update allrice_platform_model_settings
set configuration=configuration || '{"workModel":"gpt-6-luna","reasoningEffort":"xhigh"}'::jsonb,
    revision=revision+1, updated_at=now()
where singleton and configuration->>'workModel' in (
  'gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.5','gpt-5.4','gpt-5.4-mini'
);
