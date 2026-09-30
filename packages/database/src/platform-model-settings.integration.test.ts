import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
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
  it('sets GPT-6.1 Sol once while retaining reasoning, images, connection and timeout', async () => {
    const f = await createAssistantFixtureDatabase();
    try {
      const migration = await readFile(
        new URL('../migrations/0122_gpt61_sol_default.sql', import.meta.url),
        'utf8',
      );
      const [initial] =
        await f.db`select configuration from allrice_platform_model_settings where singleton`;
      assert.ok(initial);
      const original = {
        ...initial.configuration,
        workModel: 'gpt-6-sol',
        reasoningEffort: 'low',
        imageModel: 'auto',
        imagesEnabled: true,
        timeoutMs: 600_000,
      };
      await f.db`update allrice_platform_model_settings set configuration=${f.db.json(original)},revision=10 where singleton`;
      await f.db.unsafe(migration);
      await f.db.unsafe(migration);
      const [next] =
        await f.db`select revision,configuration from allrice_platform_model_settings where singleton`;
      expect(next).toMatchObject({
        revision: 11,
        configuration: { ...original, workModel: 'gpt-6.1-sol' },
      });
      const catalog = await f.db`
        select m.model,m.display_name,m.context_window_tokens,m.input_modalities,m.reasoning_efforts
        from allrice_model_catalog_entries m join allrice_model_providers p on p.id=m.provider_id
        where m.model='gpt-6.1-sol' and p.provider_key='codex'`;
      expect(catalog).toEqual([
        {
          model: 'gpt-6.1-sol',
          display_name: 'GPT-6.1 Sol',
          context_window_tokens: 272000,
          input_modalities: ['text', 'image'],
          reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
        },
      ]);
    } finally {
      await f.close();
    }
  }, 40_000);
  it('migrates only retired defaults to Luna/xhigh and preserves other configuration', async () => {
    const f = await createAssistantFixtureDatabase();
    try {
      const migration = await readFile(
        new URL('../migrations/0119_gpt6_platform_models.sql', import.meta.url),
        'utf8',
      );
      const [initial] =
        await f.db`select revision,configuration from allrice_platform_model_settings where singleton`;
      assert.ok(initial);
      expect(initial.configuration).toMatchObject({
        workModel: 'gpt-6.1-sol',
        reasoningEffort: 'xhigh',
      });
      for (const workModel of [
        'gpt-5.6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.3-codex-spark',
      ]) {
        const original = {
          ...initial.configuration,
          workModel,
          reasoningEffort: 'low',
          imageModel: 'auto',
          imagesEnabled: true,
          timeoutMs: 600_000,
        };
        await f.db`update allrice_platform_model_settings set configuration=${f.db.json(original)},revision=10 where singleton`;
        await f.db.unsafe(migration);
        const [next] =
          await f.db`select revision,configuration from allrice_platform_model_settings where singleton`;
        assert.ok(next);
        const preserved = workModel === 'gpt-5.3-codex-spark';
        expect(next.configuration).toEqual(
          preserved
            ? original
            : {
                ...original,
                workModel: 'gpt-6-luna',
                reasoningEffort: 'xhigh',
              },
        );
        expect(next.revision).toBe(preserved ? 10 : 11);
        await f.db.unsafe(migration);
        expect(
          (
            await f.db`select revision from allrice_platform_model_settings where singleton`
          )[0]?.revision,
        ).toBe(next.revision);
      }
    } finally {
      await f.close();
    }
  }, 40_000);
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
          workModel: 'gpt-6.1-sol',
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
        model: 'gpt-6.1-sol',
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
