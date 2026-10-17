import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantWorkerBridge } from '../../src/harness/dsh/assistant-bridge.js';
import { rememberWorkspaceMemory } from '../../src/tool-broker/handlers/workspace.js';
import type { RiceToolExecutionInput } from '../../src/tool-broker/types.js';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('memory failure completion receipts', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    database = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    await database?.close();
    vi.unstubAllEnvs();
  });
  it.each(['refused', 'uncertain'] as const)(
    'keeps %s distinct at the real assistant completion gate',
    async (mode) => {
      const f = await assistantFixture(database.db);
      // Synthetic fixture setup, before any tool/model admission. No live
      // authority or customer snapshots are changed by this test.
      await database.db`update allrice_assistant_instances set allowed_tools=${database.db.json(['workspace.memory.remember'])} where run_id=${f.task.rootRunId}`;
      const write = vi.fn(async () => {
        throw new Error('commit acknowledgement lost');
      });
      const bridge = createAssistantWorkerBridge({
        runtime: f.runtime,
        task: f.task,
        context: f.context,
        worker: f.worker,
        wireNames: {},
        readOnlyTools: new Set(),
        onRootTool: (call) =>
          rememberWorkspaceMemory({
            input: {
              context: {
                ...f.context,
                runId: f.task.rootRunId,
                executionId: f.task.rootRunId,
                delegatedBy: f.context.actor,
                policySnapshot: { memberships: f.context.memberships },
                startedAt: new Date().toISOString(),
              } as RiceToolExecutionInput['context'],
              call,
              capabilities: ['storage:write'],
              storageRoot: database.storageRoot,
              employeeId: randomUUID(),
              userMessageId: randomUUID(),
              userRequest:
                mode === 'refused' ? '你记在哪里啦' : '请记住我的观察名单。',
              memoryCreate: write,
            },
            arguments: call.arguments,
          }),
      });
      await expect(
        bridge.handle('tool', {
          nativeSessionId: f.nativeSessionId,
          callId: randomUUID(),
          name: 'workspace.memory.remember',
          arguments: {
            content: '观察名单：NVDA、COIN。',
            lifecycleState: 'durable',
          },
        }),
      ).rejects.toThrow(
        mode === 'refused'
          ? '只有用户在当前消息中明确要求记住'
          : 'commit acknowledgement lost',
      );
      expect(write).toHaveBeenCalledTimes(mode === 'refused' ? 0 : 1);
      const outcome = await f.runtime.finalizeRoot(f.base);
      expect(outcome.status).toBe(mode === 'refused' ? 'completed' : 'unknown');
      const [open] =
        await database.db`select count(*)::int n from allrice_assistant_usage where root_run_id=${f.task.rootRunId} and settled_amount is null`;
      expect(open!.n).toBe(mode === 'refused' ? 0 : 4);
    },
  );
});
