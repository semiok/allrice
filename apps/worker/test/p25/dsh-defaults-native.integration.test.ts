/** Actual AllRice host, pinned DSH tools and PostgreSQL event receipts.
 * Only the HTTP model and its credential are synthetic. */
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendJobEvent } from '@allrice/database';
import * as databaseClient from '../../../../packages/database/src/core/client.ts';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { normalizeHarnessRunEvent } from '../../src/harness/runtime-contract.js';
import { p24Fixture } from '../p24/fixture.js';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration('MET-210 native Todo defaults through the AllRice host', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    database = await createAssistantFixtureDatabase();
    vi.spyOn(databaseClient, 'getDatabase').mockReturnValue(database.db);
  }, 120_000);

  afterAll(async () => {
    try {
      await database?.close();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it('persists two simultaneous in-progress tasks and the native repeat reminder without rejecting Todo writes', async () => {
    const request =
      '帮我安排发布前的检查：核对接口和核对页面可以同时进行，先把这两项都标成进行中，最后再汇总结果。';
    const todos = [
      { content: '核对接口', status: 'in_progress' },
      { content: '核对页面', status: 'in_progress' },
      { content: '汇总结果', status: 'pending' },
    ];
    // A repeating model exercises the native advisory reminder at its first
    // threshold. No AllRice policy is substituted for either native plugin.
    const model = await p24Fixture(async (_request, index) =>
      index <= 3
        ? { nativeTool: { name: 'todo_write', arguments: { todos } } }
        : { text: '检查已安排。' },
    );
    const root = await realpath(model.root);
    vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(root, 'platform'));
    const adapter = new DshHarnessAdapter({
      runtimeRoot: join(root, 'native'),
      credentialResolver: {
        resolve: async () => ({ apiKey: 'synthetic-only' }),
      },
      requestTimeoutMs: 15_000,
    });
    try {
      // Only fixture creation needs assistants enabled. Restore the caller's
      // setting before exercising the host without any assistant tools.
      const assistantsEnabled = process.env.ALLRICE_ASSISTANTS_ENABLED;
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      const f = await createAssistantAuthorityFixture(database.db, {
        configure: false,
        allowedTools: [],
      }).finally(() => {
        vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', assistantsEnabled);
      });
      await adapter.execute({
        kernel: {
          schemaVersion: 1,
          harness: 'dsh',
          employeeAssignmentId: f.assignment,
          employeeVersionId: f.version,
          sessionId: f.session,
          userMessageId: randomUUID(),
          assistantMessageId: randomUUID(),
          systemInstructions: '根据用户要求管理任务清单。',
          userRequest: request,
          bootstrapConversation: '',
          authorizedMemoryContext: '',
          grantedCapabilities: ['model:invoke'],
          skillVersionIds: [],
          imageAttachments: [],
        },
        providerSnapshot: {
          provider: 'dsh',
          authMode: 'allrice_credential',
          route: 'openai-compatible',
          model: 'p24-synthetic',
          reasoningEffort: 'none',
          credentialReference: 'test:synthetic',
          baseUrl: model.baseUrl,
        },
        storageObjects: [],
        workDirectory: root,
        executionEnvironment: {
          ALLRICE_ORGANIZATION_ID: f.org,
          ALLRICE_WORKSPACE_ID: f.workspace,
          ALLRICE_OWNER_ID: f.user,
          ALLRICE_RUN_ID: f.rootRunId,
          ALLRICE_JOB_ID: f.worker.jobId,
          ALLRICE_ATTEMPT: '1',
        },
        signal: AbortSignal.timeout(30_000),
        attempt: 1,
        generation: f.worker.generation,
        tools: [],
        onEvent: async (event) => {
          // Same projection and durable sink as job-runner.ts.
          const normalized = normalizeHarnessRunEvent(event);
          await appendJobEvent({ ...f.worker, ...normalized });
        },
      });

      const rows = await database.db`
        select event_type, payload from allrice_run_events
        where run_id=${f.rootRunId} order by occurred_at, id`;
      const writes = rows.filter(
        (row) => row.payload.sourceEventType === 'todo/write',
      );
      expect(writes).toHaveLength(3);
      for (const row of writes)
        expect(row).toMatchObject({
          event_type: 'harness.native',
          payload: {
            conversationId: f.session,
            nativePayload: { todos, count: 3, completed: 0 },
          },
        });
      expect(
        rows.filter(
          (row) =>
            row.event_type === 'tool.completed' &&
            row.payload.name === 'todo_write',
        ),
      ).toHaveLength(3);
      expect(rows.filter((row) => row.event_type === 'tool.failed')).toEqual(
        [],
      );
      expect(
        rows.filter(
          (row) =>
            row.payload.nativePayload?.source?.kind === 'repeat-tool-reminder',
        ),
      ).toHaveLength(1);
      expect(model.requests).toHaveLength(4);
      expect(
        JSON.stringify(
          model.requests[3]!.messages.filter(({ role }) => role === 'user'),
        ),
      ).toContain(
        'You are repeating the exact same tool call with identical arguments.',
      );
      expect(JSON.stringify(model.requests[0]!.messages)).toContain(request);
    } finally {
      await adapter.close();
      await model.close();
    }
  }, 60_000);
});
