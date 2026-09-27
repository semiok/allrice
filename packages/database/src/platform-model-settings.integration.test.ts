import { afterEach, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { withFixturePlatformAdministrator } from '../../../scripts/acceptance/runtime/fixture-platform-authority.ts';
import {
  readPlatformModelSettings,
  updatePlatformModelSettings,
  PlatformModelSettingsConflict,
} from './providers/platform-model-settings.ts';
import { freezeSessionModelSnapshot } from './providers/model-pool.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('platform-wide model inheritance', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('freezes each Run, updates old sessions for the next Run, rejects stale/non-admin writes', async () => {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    const f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
    try {
      const task = await f.prepareOrdinaryTask(
        'Synthetic configuration test; no model call.',
      );
      const original = task.binding.executionSnapshot.modelSnapshot!;
      const settings = await readPlatformModelSettings();
      expect(original.platformSettings?.revision).toBe(settings.revision);
      const update = {
        expectedRevision: settings.revision,
        configuration: {
          ...settings.configuration,
          workModel: 'gpt-5.5',
          imagesEnabled: true,
        },
      };
      await expect(
        updatePlatformModelSettings(f.context, update),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await withFixturePlatformAdministrator(f.ownerId, async () => {
        const next = await updatePlatformModelSettings(f.context, update);
        expect(next.revision).toBe(settings.revision + 1);
        await expect(
          updatePlatformModelSettings(f.context, update),
        ).rejects.toBeInstanceOf(PlatformModelSettingsConflict);
        await expect(
          updatePlatformModelSettings(f.context, {
            expectedRevision: next.revision,
            configuration: {
              ...next.configuration,
              workModel: 'gemini-3.8-flash',
            },
          }),
        ).rejects.toThrow();
      });
      const next = await freezeSessionModelSnapshot({
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        sessionId: task.sessionId,
      });
      expect(next).toMatchObject({
        model: 'gpt-5.5',
        provider: 'openai-codex',
        fallbackPolicy: 'disabled',
        resolvedFallbacks: [],
      });
      expect(next.platformSettings?.configuration.imagesEnabled).toBe(true);
      expect(original.model).toBe('gpt-5.6-luna');
      expect(original.platformSettings?.configuration.imagesEnabled).toBe(
        false,
      );
      const [bound] = await f.db<
        { execution_snapshot: { modelSnapshot: unknown } }[]
      >`select execution_snapshot from allrice_employee_runs where run_id=${task.runId}`;
      expect(bound?.execution_snapshot.modelSnapshot).toEqual(original);
      const retired = await f.db<
        { enabled: boolean }[]
      >`select enabled from allrice_model_providers where provider_key='gemini' or auth_mode='gemini_oauth'`;
      expect(retired.every((row) => !row.enabled)).toBe(true);
    } finally {
      await f.close();
    }
  }, 40_000);
});
