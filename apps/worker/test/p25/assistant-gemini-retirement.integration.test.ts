import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'retired Gemini runs remain readable but cannot start new execution',
  () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });

    it('rejects a persisted Gemini snapshot before credentials, children or model dispatch, even with the old enable flag', async () => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
      const f = await createAssistantAuthorityFixture(database.db, {
        configure: false,
        runtimePolicy: {
          harness: 'dsh',
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          reasoningEffort: 'low',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'test:retired-gemini-never-resolved',
          baseUrl: null,
        },
      });
      const [before] =
        await database.db`select provider_snapshot from allrice_employee_runs where run_id=${f.rootRunId}`;
      expect(before!.provider_snapshot).toMatchObject({
        provider: 'dsh',
        route: 'gemini',
        model: 'gemini-3.8-flash',
      });
      const root = await mkdtemp(join(tmpdir(), 'allrice-gemini-retired-'));
      const resolveCredential = vi.fn(async () => {
        throw Error('Retired credentials must never be resolved');
      });
      const adapter = new DshHarnessAdapter({
        runtimeRoot: root,
        credentialResolver: { resolve: resolveCredential },
      });
      const onEvent = vi.fn();
      try {
        await expect(
          adapter.execute({
            kernel: {
              schemaVersion: 1,
              harness: 'dsh',
              employeeAssignmentId: f.assignment,
              employeeVersionId: f.version,
              sessionId: f.session,
              userMessageId: randomUUID(),
              assistantMessageId: randomUUID(),
              systemInstructions: 'Synthetic historical snapshot.',
              userRequest: 'Must not reach any model.',
              bootstrapConversation: '',
              authorizedMemoryContext: '',
              grantedCapabilities: ['model:invoke'],
              skillVersionIds: [],
              imageAttachments: [],
            },
            providerSnapshot: before!.provider_snapshot,
            storageObjects: [],
            workDirectory: root,
            executionEnvironment: {
              ALLRICE_ORGANIZATION_ID: f.org,
              ALLRICE_WORKSPACE_ID: f.workspace,
              ALLRICE_OWNER_ID: f.user,
            },
            signal: new AbortController().signal,
            attempt: 1,
            generation: f.worker.generation,
            threadId: `dsh-${f.session}`,
            tools: [],
            onEvent,
          }),
        ).rejects.toMatchObject({ code: 'GEMINI_API_DISABLED' });
        expect(resolveCredential).not.toHaveBeenCalled();
        expect(onEvent).not.toHaveBeenCalled();
        expect(
          await database.db`select 1 from allrice_assistant_model_admissions where root_run_id=${f.rootRunId}`,
        ).toHaveLength(0);
        expect(
          await database.db`select provider_snapshot from allrice_employee_runs where run_id=${f.rootRunId}`,
        ).toEqual([before]);
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
