-- MET-81/MET-85: remove the last live Codex Harness default from the
-- conversation runtime table. Historical RunEvents and route decisions keep
-- their original values for replay, but every active/new runtime is DSH.

alter table allrice_conversation_runtimes
  drop constraint if exists allrice_conversation_runtimes_provider_check;

update allrice_conversation_runtimes
set provider = 'dsh'
where provider <> 'dsh';

alter table allrice_conversation_runtimes
  alter column provider set default 'dsh';

alter table allrice_conversation_runtimes
  add constraint allrice_conversation_runtimes_provider_check
  check (provider = 'dsh');

update allrice_runtime_metadata
set value = value || '{"provider":"dsh-sdk","codexRole":"provider","codexRoute":"openai-codex"}'::jsonb,
    updated_at = now()
where key = 'durable-conversation-runtime-schema';

update allrice_runtime_metadata
set value = value || '{"finalizedBy":"0039"}'::jsonb,
    updated_at = now()
where key = 'single-dsh-harness';
