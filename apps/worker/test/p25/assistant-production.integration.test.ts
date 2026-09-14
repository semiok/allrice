import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { createAssistantWorkerBridge } from '../../src/harness/dsh/assistant-bridge.js';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
import { assertAssistantAuthority } from '../../../../packages/database/src/assistant-authority.ts';
import { p24Fixture, gate } from '../p24/fixture.js';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'P25 production adapter + production restricted host + actual native services + isolated PG (synthetic HTTP model)',
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
    it('the actual native parent model delegates two children through the production transport and adopts their durable results', async () => {
      const f = await createAssistantAuthorityFixture(database.db, {
        configure: false,
        allowedTools: ['assistant.delegate', 'assistant.report'],
      });
      const productSessionId = f.session,
        nativeSessionId = `dsh-${productSessionId}`;
      // Remove only this new synthetic fixture's empty permissive ledger. The
      // production controller must create the actual frozen root/budgets below.
      await database.db.begin(async (tx) => {
        await tx`delete from allrice_runtime_budgets where root_run_id=${f.task.runId}`;
        await tx`delete from allrice_runtime_run_links where root_run_id=${f.task.runId}`;
        await tx`delete from allrice_runtime_roots where root_run_id=${f.task.runId}`;
      });
      const overlap = gate();
      let activeChildren = 0,
        maximumActiveChildren = 0;
      const model = await p24Fixture(async (request) => {
        const serialized = JSON.stringify(request.messages);
        if (!serialized.includes('ROOT_PRIVATE')) {
          activeChildren++;
          maximumActiveChildren = Math.max(
            maximumActiveChildren,
            activeChildren,
          );
          await overlap.promise;
          activeChildren--;
          return {
            nativeTool: {
              name: 'assistant_report',
              arguments: {
                status: 'partial',
                summary: 'Isolated child checked synthetic input',
                evidence: [],
                incomplete: ['No published artifact'],
              },
            },
          };
        }
        if (!serialized.includes('ANALYZE_A'))
          return {
            nativeTool: {
              name: 'assistant_delegate',
              arguments: {
                label: 'A',
                text: 'ANALYZE_A',
                tools: ['assistant.report'],
              },
            },
          };
        if (!serialized.includes('ANALYZE_B'))
          return {
            nativeTool: {
              name: 'assistant_delegate',
              arguments: {
                label: 'B',
                text: 'ANALYZE_B',
                tools: ['assistant.report'],
              },
            },
          };
        return { text: 'Root final synthesis of bounded partial evidence.' };
      });
      vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(model.root, 'platform'));
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
        wireNames: {
          'assistant.delegate': 'assistant_delegate',
          'assistant.report': 'assistant_report',
        },
        readOnlyTools: new Set(),
      });
      try {
        const execution = adapter.execute({
          kernel: {
            schemaVersion: 1,
            harness: 'dsh',
            employeeAssignmentId: randomUUID(),
            employeeVersionId: randomUUID(),
            sessionId: productSessionId,
            userMessageId: randomUUID(),
            assistantMessageId: randomUUID(),
            systemInstructions:
              'Use available native tools for bounded independent tasks.',
            userRequest:
              'ROOT_PRIVATE: delegate independent A and B tasks, then summarize.',
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
          tools: ['assistant.delegate', 'assistant.report'].map((name) => ({
            name,
            description: name,
            inputSchema: { type: 'object' },
          })),
          onEvent: async () => {},
          assistants: productionAssistantController({
            configuration: f.config,
            database: database.db,
            authorize: assertAssistantAuthority,
            worker: f.worker,
            tools: [
              { name: 'assistant.delegate' },
              { name: 'assistant.report' },
            ],
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
          }),
        });
        execution.catch(() => {});
        await expect.poll(() => activeChildren, { timeout: 15000 }).toBe(2);
        expect(maximumActiveChildren).toBe(2);
        overlap.release();
        const result = await execution;
        expect(result.answer).toContain('Root final synthesis');
        const tree = await bridge.tree();
        expect(tree.instances).toHaveLength(3);
        expect(tree.results).toHaveLength(2);
        expect(
          tree.results.every((result) => result.parentAdoptedSeq !== null),
        ).toBe(true);
        expect(
          tree.messages.every((message) => message.status === 'adopted'),
        ).toBe(true);
        expect(
          model.requests.some(
            (request) =>
              JSON.stringify(request).includes('ANALYZE_A') &&
              !JSON.stringify(request).includes('ROOT_PRIVATE'),
          ),
        ).toBe(true);
        expect(
          tree.budgets.find((budget) => budget.metric === 'model_calls')!.spent,
        ).toBe(model.requests.length);
      } finally {
        overlap.release();
        await adapter.close();
        await model.close();
      }
    }, 60000);
  },
);
