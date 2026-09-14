import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LocalStorageAdapter } from '../../../../packages/storage/src/index.ts';
import {
  getWorkbenchArtifact,
  readArtifactBytes,
} from '../../../../packages/database/src/artifact-review.ts';
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
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });
    it.each(['completed', 'revoked'] as const)(
      'the actual native parent delegates concurrent children: %s',
      async (outcome) => {
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
              usage: {
                prompt_tokens: 1000,
                prompt_tokens_details: { cached_tokens: 900 },
                completion_tokens: 5,
                total_tokens: 1005,
              },
              nativeTool: {
                name: 'assistant_report',
                arguments: {
                  status: 'completed',
                  summary: 'Isolated child checked synthetic input',
                  evidence: [],
                  incomplete: [],
                  output: {
                    name: 'report',
                    content: JSON.stringify({
                      analysis: serialized.includes('ANALYZE_A') ? 'A' : 'B',
                      source: 'synthetic input; not independently verified',
                    }),
                  },
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
              storage,
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
          if (outcome === 'revoked') {
            await database.db`update allrice_memberships set active=false where id=${f.membership}`;
            await expect(execution).rejects.toThrow();
            await expect
              .poll(() => model.abortedRequests.length, { timeout: 10000 })
              .toBe(2);
            // A dead process is not a platform receipt; uncertainty is retained.
            const rows =
              await database.db`select stopped_at from allrice_assistant_instances where root_run_id=${f.rootRunId} and depth>0`;
            expect(rows.every((row) => row.stopped_at === null)).toBe(true);
            return;
          }
          overlap.release();
          const result = await execution;
          expect(result.answer).toContain('Root final synthesis');
          const tree = await bridge.tree();
          expect(tree.instances).toHaveLength(3);
          expect(
            tree.instances.find((instance) => instance.parentRunId === null),
          ).toMatchObject({
            status: 'completed',
            stoppedAt: expect.any(String),
          });
          expect(tree.results.every((result) => result.usageComplete)).toBe(
            true,
          );
          expect(tree.results).toHaveLength(2);
          const ids = tree.results.flatMap((result) =>
            result.evidence.map((item) => item.id),
          );
          expect(new Set(ids).size).toBe(2);
          for (const report of tree.results) {
            const artifact = await getWorkbenchArtifact(
              f.context,
              f.session,
              report.evidence[0]!.id,
              database.db,
            );
            expect(artifact.provenance).toMatchObject({
              kind: 'model_proposal',
              runId: report.runId,
            });
            const [object] =
              await database.db`select o.* from allrice_storage_objects o join allrice_deliverable_versions v on v.object_id=o.id where v.id=${report.evidence[0]!.id}`;
            const bytes = await readArtifactBytes(storage, {
              id: object!.id,
              organizationId: f.org,
              workspaceId: f.workspace,
              ownerId: f.user,
              key: object!.object_key,
              mediaType: object!.media_type,
              sizeBytes: Number(object!.size_bytes),
              checksum: object!.checksum,
              immutable: true,
              retentionUntil: null,
              deletedAt: null,
            });
            expect(JSON.parse(Buffer.from(bytes).toString())).toMatchObject({
              kind: 'assistant_generated',
              independentlyVerified: false,
              name: 'report',
              childRunId: report.runId,
            });
          }
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
            tree.budgets.find((budget) => budget.metric === 'model_calls')!
              .spent,
          ).toBe(model.requests.length);
          expect(
            tree.budgets.find((budget) => budget.metric === 'input_tokens')!
              .spent,
          ).toBe(2000 + (model.requests.length - 2) * 20);
        } finally {
          overlap.release();
          await adapter.close();
          await model.close();
        }
      },
      60000,
    );
  },
);
