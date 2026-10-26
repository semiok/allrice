import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LocalStorageAdapter } from '../../../../packages/storage/src/index.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
import { assertAssistantAuthority } from '../../../../packages/database/src/assistant-authority.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import type { HarnessExecutionInput } from '../../src/harness/adapter.js';
import { createAssistantWorkerBridge } from '../../src/harness/dsh/assistant-bridge.js';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';
import { p24Fixture, gate } from '../p24/fixture.js';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
// MET-210 Dev acceptance, as a user does it: Rice delegates a long child A and
// a quick child B; while Rice is still working, the user presses
// "停止这个助手" on A (the web route's stop_child calls cancelChild). The
// Worker's own cancellation poll drains A through the real native host.
integration(
  'P25 production adapter: the user stops one of two child assistants',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });
    it('the root run ends completed with B adopted and A stopped', async () => {
      const f = await createAssistantAuthorityFixture(database.db, {
        configure: false,
        memberRole: 'member',
        allowedTools: ['assistant.delegate', 'assistant.report'],
      });
      const nativeSessionId = `dsh-${f.session}`;
      // The production controller creates the frozen root and budgets itself.
      await database.db.begin(async (tx) => {
        await tx`delete from allrice_runtime_budgets where root_run_id=${f.task.runId}`;
        await tx`delete from allrice_runtime_run_links where root_run_id=${f.task.runId}`;
        await tx`delete from allrice_runtime_roots where root_run_id=${f.task.runId}`;
      });
      const holdA = gate(),
        rootWorking = gate(),
        rootRelease = gate();
      let rootHeld = false;
      const model = await p24Fixture(async (request) => {
        const serialized = JSON.stringify(request.messages);
        if (!serialized.includes('ROOT_PRIVATE')) {
          if (serialized.includes('WRITE_NOVEL_A')) {
            await holdA.promise;
            return { text: 'A never finishes before the stop.' };
          }
          return {
            nativeTool: {
              name: 'assistant_report',
              arguments: {
                status: 'completed',
                summary:
                  'Longjing tea comes from the West Lake area of Hangzhou.',
                evidence: [],
                incomplete: [],
                output: {
                  name: 'answer',
                  content: JSON.stringify({ origin: 'Hangzhou West Lake' }),
                },
              },
            },
          };
        }
        if (!serialized.includes('WRITE_NOVEL_A'))
          return {
            nativeTool: {
              name: 'assistant_delegate',
              arguments: {
                label: 'A',
                text: 'WRITE_NOVEL_A: a 5000-character story in 10 chapters',
                tools: ['assistant.report'],
              },
            },
          };
        if (!serialized.includes('ANSWER_B'))
          return {
            nativeTool: {
              name: 'assistant_delegate',
              arguments: {
                label: 'B',
                text: 'ANSWER_B: where does Longjing tea come from, in one sentence',
                tools: ['assistant.report'],
              },
            },
          };
        // Rice is still mid-turn when the user stops A.
        if (!rootHeld) {
          rootHeld = true;
          rootWorking.release();
          await rootRelease.promise;
        }
        return {
          text: 'Summary: Longjing tea is from Hangzhou; A was stopped.',
        };
      });
      vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(model.root, 'platform'));
      const storage = new LocalStorageAdapter(join(model.root, 'outputs'));
      const adapter = new DshHarnessAdapter({
        runtimeRoot: join(model.root, 'production-runtime'),
        credentialResolver: {
          resolve: async () => ({ apiKey: 'synthetic-only' }),
        },
      });
      const bridge = createAssistantWorkerBridge({
        runtime: f.runtime,
        task: f.task,
        context: f.context,
        worker: f.worker,
        wireNames: {},
        readOnlyTools: new Set(),
      });
      const tools = ['assistant.delegate', 'assistant.report'];
      const assistants = productionAssistantController({
        deliveryMode: 'legacy',
        configuration: f.config,
        database: database.db,
        authorize: assertAssistantAuthority,
        storage,
        worker: f.worker,
        tools: tools.map((name) => ({ name })),
        runLimits: { maxOutputTokens: 5000 },
        context: {
          executionId: randomUUID(),
          runId: f.task.runId,
          jobId: f.worker.jobId,
          worker: { type: 'worker', id: f.worker.workerId },
          delegatedBy: { type: 'user', id: f.user },
          organizationId: f.org,
          workspaceId: f.workspace,
          startedAt: new Date().toISOString(),
          policySnapshot: {
            id: f.policy,
            organizationId: f.org,
            subjectId: f.user,
            version: 1,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            memberships: f.context.memberships,
            grants: [
              {
                resourceType: 'job',
                action: 'job:execute',
                workspaceId: f.workspace,
              },
            ],
          },
        },
      });
      const children = async () =>
        (await bridge.tree()).instances.filter((i) => i.parentRunId !== null);
      try {
        const execution = adapter.execute({
          kernel: {
            schemaVersion: 1,
            harness: 'dsh',
            employeeAssignmentId: randomUUID(),
            employeeVersionId: randomUUID(),
            sessionId: f.session,
            userMessageId: randomUUID(),
            assistantMessageId: randomUUID(),
            systemInstructions:
              'Use native child assistants for parallel work.',
            userRequest:
              'ROOT_PRIVATE: 请用两个子助理并行做：A 写一篇 5000 字的小说，B 用一句话回答龙井茶的产地；两个都有结果后再汇总。',
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
          workDirectory: model.root,
          executionEnvironment: {
            ALLRICE_ORGANIZATION_ID: f.task.scope.organizationId,
            ALLRICE_WORKSPACE_ID: f.task.scope.workspaceId,
            ALLRICE_OWNER_ID: f.context.actor.id,
          },
          signal: new AbortController().signal,
          attempt: 1,
          generation: f.worker.generation,
          maxOutputTokens: 1000,
          threadId: nativeSessionId,
          tools: tools.map((name) => ({
            name,
            description: name,
            inputSchema: { type: 'object' },
          })),
          onEvent: async () => {},
          assistants: assistants as NonNullable<
            HarnessExecutionInput['assistants']
          >,
        });
        execution.catch(() => {});
        // B has delivered; A is still writing; Rice is mid-turn.
        await rootWorking.promise;
        await expect
          .poll(
            async () => {
              const kids = await children();
              const results = (await bridge.tree()).results;
              return (
                kids.length === 2 &&
                kids.some((k) => k.status === 'running') &&
                results.length === 1
              );
            },
            { timeout: 15000 },
          )
          .toBe(true);
        const [a, b] = await children();
        expect(a!.label).toBe('A');
        // The user presses "停止这个助手" on A.
        await f.runtime.cancelChild(f.context, {
          runId: f.task.runId,
          childRunId: a!.runId,
          requestId: randomUUID(),
        });
        await expect
          .poll(
            async () =>
              (await children()).find((k) => k.runId === a!.runId)?.stoppedAt,
            { timeout: 15000 },
          )
          .toEqual(expect.any(String));
        rootRelease.release();
        const result = await execution;
        expect(result.answer).toContain('Longjing tea is from Hangzhou');
        expect(result.assistantStatus).toBe('completed');
        const tree = await bridge.tree();
        expect(tree.cancelRequested).toBe(false);
        expect(
          tree.instances.find((i) => i.parentRunId === null),
        ).toMatchObject({ status: 'completed', stoppedAt: expect.any(String) });
        expect(tree.instances.find((i) => i.runId === a!.runId)).toMatchObject({
          status: 'canceled',
          cancelRequestedAt: expect.any(String),
          stoppedAt: expect.any(String),
        });
        expect(tree.results.find((r) => r.runId === b!.runId)).toMatchObject({
          status: 'completed',
          parentAdoptedSeq: expect.any(Number),
        });
        // Native settles A on its own schedule: before the stop receipt it
        // leaves a partial stop receipt, after it nothing. Neither is adopted.
        const stopReceipt = tree.results.filter((r) => r.runId === a!.runId);
        expect(stopReceipt.length).toBeLessThanOrEqual(1);
        for (const receipt of stopReceipt)
          expect(receipt).toMatchObject({
            status: 'partial',
            parentAdoptedSeq: null,
          });
        expect(tree.results).toHaveLength(1 + stopReceipt.length);
        const runs =
          await database.db`select id,state from allrice_runs where id in ${database.db([a!.runId, b!.runId])}`;
        expect(Object.fromEntries(runs.map((r) => [r.id, r.state]))).toEqual({
          [a!.runId]: 'canceled',
          [b!.runId]: 'succeeded',
        });
      } finally {
        holdA.release();
        rootRelease.release();
        await adapter.close();
        await model.close();
      }
    }, 90000);
  },
);
