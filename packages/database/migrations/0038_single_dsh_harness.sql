-- MET-81/MET-85 convergence: Codex is a platform Provider inside DSH.
-- Historical Harness events and immutable route decisions keep their original
-- values for audit. All provider catalog routing and new employee policies use
-- DSH as the only execution Harness.

update allrice_model_providers
set harness = 'dsh', updated_at = now()
where provider_key = 'codex' and harness <> 'dsh';

update allrice_runtime_metadata
set value = jsonb_set(
  value,
  '{tokenStorage}',
  '"dsh-private-credential-store"'::jsonb,
  true
), updated_at = now()
where key = 'codex-subscription-auth-broker';

insert into allrice_runtime_metadata (key, value)
values (
  'single-dsh-harness',
  '{"version":"0038","issue":"MET-81/MET-85","harness":"dsh","codexRole":"provider","codexRoute":"openai-codex"}'::jsonb
)
on conflict (key) do update
set value = excluded.value, updated_at = now();
