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
import type { HarnessExecutionInput } from '../../src/harness/adapter.js';
import type { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.js';
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
    it.each([
      'completed',
      'missing_report',
      'invalid_report',
      'dynamic_output',
      'revoked',
      'revoked_policy',
      'revoked_employee',
      'revoked_assignment',
      'revoked_flag',
      'unknown_usage',
      'unknown_output',
      'unknown_input',
    ] as const)(
      'the actual native parent delegates concurrent children: %s',
      async (outcome) => {
        const f = await createAssistantAuthorityFixture(database.db, {
          configure: false,
          memberRole: outcome === 'completed' ? 'member' : 'admin',
          allowedTools: ['assistant.delegate', 'assistant.report'],
        });
        const productSessionId = f.session,
          nativeSessionId = `dsh-${productSessionId}`;
        if (outcome === 'dynamic_output') {
          f.config.maxConcurrent = 2;
          await database.db`update allrice_runs set input=jsonb_set(input,'{assistantConfiguration}',${database.db.json(f.config)}) where id=${f.rootRunId}`;
        }
        // Remove only this new synthetic fixture's empty permissive ledger. The
        // production controller must create the actual frozen root/budgets below.
        await database.db.begin(async (tx) => {
          await tx`delete from allrice_runtime_budgets where root_run_id=${f.task.runId}`;
          await tx`delete from allrice_runtime_run_links where root_run_id=${f.task.runId}`;
          await tx`delete from allrice_runtime_roots where root_run_id=${f.task.runId}`;
        });
        const overlap = gate();
        const completionReached = gate(),
          completionReleased = gate();
        let activeChildren = 0,
          maximumActiveChildren = 0,
          triedMissingReport = false;
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
            if (
              outcome === 'invalid_report' &&
              !serialized.includes('assistant_report_delivery_required')
            )
              return {
                nativeTool: {
                  name: 'assistant_report',
                  arguments: {
                    status: 'completed',
                    summary: 'Synthetic calculation',
                    evidence: [],
                    incomplete: [],
                  },
                },
              };
            return {
              usage:
                outcome === 'unknown_usage'
                  ? null
                  : outcome === 'unknown_output'
                    ? { prompt_tokens: 1000, total_tokens: 1000 }
                    : outcome === 'unknown_input'
                      ? { completion_tokens: 5, total_tokens: 5 }
                      : {
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
          if (outcome === 'missing_report' && !triedMissingReport) {
            triedMissingReport = true;
            return {
              nativeTool: {
                name: 'assistant_delegate',
                arguments: { label: 'Invalid', text: 'NO_REPORT', tools: [] },
              },
            };
          }
          if (outcome === 'missing_report')
            expect(serialized).toContain('assistant_report_required');
          if (!serialized.includes('ANALYZE_A'))
            return {
              ...(outcome === 'dynamic_output'
                ? {
                    usage: {
                      prompt_tokens: 20,
                      completion_tokens: 123,
                      total_tokens: 143,
                    },
                  }
                : {}),
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
              ...(outcome === 'dynamic_output'
                ? {
                    usage: {
                      prompt_tokens: 20,
                      completion_tokens: 123,
                      total_tokens: 143,
                    },
                  }
                : {}),
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
        let controllerOptions:
          Parameters<typeof productionAssistantController>[0] | undefined;
        const stoppedReceipts = new Set<string>();
        const settledReceipts = new Set<string>();
        const controller = (
          options: Parameters<typeof productionAssistantController>[0],
        ): NonNullable<HarnessExecutionInput['assistants']> => {
          controllerOptions = options;
          const original = productionAssistantController(options);
          if (!original)
            throw new Error(
              'Production assistant controller required by fixture',
            );
          return {
            ...original,
            bind: async (...args: Parameters<typeof original.bind>) => {
              const bound = await original.bind(...args);
              return {
                ...bound,
                handle: async (...request: Parameters<typeof bound.handle>) => {
                  const result = await bound.handle(...request);
                  if (request[0] === 'stopped' && result.stopped === true)
                    stoppedReceipts.add(String(request[1].nativeSessionId));
                  if (
                    request[0] === 'settled' &&
                    typeof result.deliveryId === 'string'
                  )
                    settledReceipts.add(result.deliveryId);
                  return result;
                },
              };
            },
          };
        };
        try {
          const executionInput: HarnessExecutionInput = {
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
            assistants: controller({
              configuration: f.config,
              database: database.db,
              authorize: assertAssistantAuthority,
              storage,
              worker: f.worker,
              tools: [
                { name: 'assistant.delegate' },
                { name: 'assistant.report' },
              ],
              runLimits: {
                maxOutputTokens: outcome === 'dynamic_output' ? 12000 : 5000,
              },
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
          };
          if (outcome === 'completed') {
            const original = executionInput.assistants!;
            executionInput.assistants = {
              ...original,
              bind: async (...args) => {
                const bound = await original.bind(...args);
                return {
                  ...bound,
                  finish: async () => {
                    const result = await bound.finish!();
                    completionReached.release();
                    await completionReleased.promise;
                    return result;
                  },
                };
              },
            };
          }
          const execution = adapter.execute(executionInput);
          execution.catch(() => {});
          await expect.poll(() => activeChildren, { timeout: 15000 }).toBe(2);
          expect(maximumActiveChildren).toBe(2);
          if (outcome.startsWith('revoked')) {
            // Wait until the parent's final text model call has settled. Only
            // the two held child requests remain; a later parent admission
            // failure must not accidentally stand in for active-stream polling.
            await expect
              .poll(async () => {
                const [row] =
                  await database.db`select count(*) as calls from allrice_assistant_usage where run_id=${f.rootRunId} and metric='model_calls' and amount=1 and settled_amount=1`;
                return Number(row!.calls);
              })
              .toBe(3);
            if (outcome === 'revoked')
              await database.db`update allrice_memberships set active=false where id=${f.membership}`;
            else if (outcome === 'revoked_policy')
              await f.setControls({
                version: 1,
                enabled: true,
                mode: 'execute',
                rules: [{ action: 'assistant.delegate', effect: 'deny' }],
              });
            else if (outcome === 'revoked_employee')
              await database.db`update allrice_employees set status='archived' where id=${f.employee}`;
            else if (outcome === 'revoked_assignment')
              await database.db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
            else vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
            // No further native tool/model call and no user abort occurs: the
            // two held requests must close solely from current-authority polling.
            await expect(execution).rejects.toThrow();
            await expect
              .poll(() => model.abortedRequests.length, { timeout: 10000 })
              .toBe(2);
            // A dead process alone is not a platform receipt. A current-authority
            // poll can race with cancel/drain: only a successfully persisted
            // native stopped ACK may make stopped_at non-null. Verify the exact
            // evidence rather than requiring one scheduling order in CI.
            const rows =
              await database.db`select native_session_id,stopped_at from allrice_assistant_instances where root_run_id=${f.rootRunId} and depth>0`;
            expect(rows).toHaveLength(2);
            for (const row of rows)
              expect(row.stopped_at !== null).toBe(
                stoppedReceipts.has(row.native_session_id),
              );
            const [usage] =
              await database.db`select count(*) as unresolved from allrice_assistant_usage where root_run_id=${f.rootRunId} and settled_amount is null`;
            expect(Number(usage!.unresolved)).toBeGreaterThan(0);
            // The native settled notification may beat the stopped ACK. It
            // can persist only a partial stop receipt, never a child report or
            // parent-adopted success. Match actual acknowledgements rather
            // than assuming the stopped notification always wins the race.
            const results =
              await database.db`select delivery_id,payload,parent_adopted_seq from allrice_assistant_results where root_run_id=${f.rootRunId}`;
            expect(results.map((row) => row.delivery_id).sort()).toEqual(
              [...settledReceipts].sort(),
            );
            for (const row of results) {
              expect(row.payload).toMatchObject({
                status: 'partial',
                summary:
                  'Native assistant settled without a verified delivery.',
                evidence: [],
                usageComplete: false,
              });
              expect(row.payload.incomplete.length).toBeGreaterThan(0);
              expect(row.parent_adopted_seq).toBeNull();
            }
            return;
          }
          if (outcome === 'dynamic_output')
            await expect
              .poll(
                () =>
                  model.requests.filter((request) =>
                    JSON.stringify(request.messages).includes('ROOT_PRIVATE'),
                  ).length,
                { timeout: 10000 },
              )
              .toBe(3);
          overlap.release();
          if (outcome === 'completed') {
            await completionReached.promise;
            const pool = (adapter as unknown as { runtimePool: DshRuntimePool })
              .runtimePool;
            const owned = pool.get(nativeSessionId);
            expect(owned).toBeDefined();
            // Keep the completed DB root exposed across three former polling
            // intervals, before execute's finally. It must not be treated as a
            // new revocation or silently lose its already-owned native host.
            await new Promise((resolve) => setTimeout(resolve, 750));
            expect(pool.get(nativeSessionId)).toBe(owned);
            await expect(
              owned!.client.assistant('inspect', { nativeSessionId }),
            ).resolves.toHaveProperty('header');
            completionReleased.release();
          }
          if (outcome.startsWith('unknown_')) {
            await expect(execution).rejects.toMatchObject({
              code: 'ASSISTANT_EXECUTION_UNRESOLVED',
              retryable: false,
              usage: { inputTokens: expect.any(Number) },
            });
            const tree = await bridge.tree();
            expect(
              tree.instances.find((instance) => instance.parentRunId === null),
            ).toMatchObject({
              status: 'unknown',
              stoppedAt: expect.any(String),
            });
            expect(tree.cancelRequested).toBe(false);
            expect(
              tree.budgets.find(
                (budget) =>
                  budget.metric ===
                  (outcome === 'unknown_output'
                    ? 'output_tokens'
                    : 'input_tokens'),
              )!.reserved,
            ).toBeGreaterThan(0);
            expect(
              tree.results.every(
                (result) =>
                  !result.usageComplete && result.status === 'partial',
              ),
            ).toBe(true);
            return;
          }
          const result = await execution;
          expect(result.answer).toContain('Root final synthesis');
          const tree = await bridge.tree();
          expect(tree.instances).toHaveLength(3);
          expect(result).toMatchObject({
            assistantStatus: 'completed',
            usageComplete: true,
            cacheUsageKnown: false,
            costEstimateAvailable: false,
          });
          expect(result.usage).toEqual({
            inputTokens: tree.budgets.find(
              (budget) => budget.metric === 'input_tokens',
            )!.spent,
            cachedInputTokens: 0,
            outputTokens: tree.budgets.find(
              (budget) => budget.metric === 'output_tokens',
            )!.spent,
          });
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
          if (outcome === 'dynamic_output') {
            expect(tree.configuration.maxConcurrent).toBe(2);
            const admissions =
              await database.db`select a.*,i.label from allrice_assistant_model_admissions a join allrice_assistant_instances i on i.run_id=a.run_id where a.root_run_id=${f.rootRunId} order by a.prepared_at`;
            expect(admissions).toHaveLength(model.requests.length);
            expect(
              admissions.some((a) => Number(a.granted_output_tokens) < 4000),
            ).toBe(true);
            for (const runId of [...new Set(admissions.map((a) => a.run_id))]) {
              const calls = admissions.filter((a) => a.run_id === runId);
              const requests = model.requests.filter((request) => {
                const content = JSON.stringify(request.messages);
                return runId === f.rootRunId
                  ? content.includes('ROOT_PRIVATE')
                  : !content.includes('ROOT_PRIVATE') &&
                      content.includes(`ANALYZE_${calls[0]!.label}`);
              });
              expect(
                requests.map((request) => {
                  const wire = request as unknown as {
                    max_tokens?: number;
                    max_completion_tokens?: number;
                  };
                  return wire.max_tokens ?? wire.max_completion_tokens;
                }),
              ).toEqual(calls.map((a) => Number(a.granted_output_tokens)));
              expect(
                calls.every(
                  (a) =>
                    a.dispatched_at &&
                    a.finished_at &&
                    Number(a.granted_output_tokens) <=
                      Number(a.requested_output_tokens),
                ),
              ).toBe(true);
            }
            expect(
              tree.budgets.find((b) => b.metric === 'output_tokens'),
            ).toMatchObject({ capacity: 12000, reserved: 0 });
          }

          // Reuse the native host while the next business Run gets its own
          // lease and budget root. Old child results and usage stay on Run 1.
          const previousRuntime = adapter.runtimeInventory()[0];
          expect(previousRuntime).toBeDefined();
          const nextRunId = randomUUID(),
            nextJobId = randomUUID(),
            nextUserMessageId = randomUUID(),
            nextAssistantMessageId = randomUUID();
          const nextWorker = {
            ...f.worker,
            jobId: nextJobId,
            leaseToken: randomUUID(),
          };
          await database.db.begin(async (tx) => {
            await tx`update allrice_runs set state='succeeded' where id=${f.rootRunId}`;
            await tx`update allrice_jobs set status='succeeded' where id=${f.worker.jobId}`;
            await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input)
              select ${nextRunId},organization_id,workspace_id,owner_id,'running',policy_snapshot_id,execution_spec,input from allrice_runs where id=${f.rootRunId}`;
            await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
              select ${nextJobId},organization_id,workspace_id,owner_id,${nextRunId},'running',${randomUUID()},timeout_at,payload,worker_id,${nextWorker.leaseToken},clock_timestamp(),clock_timestamp(),lease_expires_at from allrice_jobs where id=${f.worker.jobId}`;
            await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
              values(${nextUserMessageId},${f.org},${f.workspace},${f.session},${f.user},'user','{"text":"Follow-up synthesis","citations":[]}'),
              (${nextAssistantMessageId},${f.org},${f.workspace},${f.session},${f.user},'assistant','{"text":"","citations":[]}')`;
            await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot)
              select ${nextRunId},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,${nextUserMessageId},${nextAssistantMessageId},provider_snapshot,prompt_snapshot,native_skills,execution_snapshot from allrice_employee_runs where run_id=${f.rootRunId}`;
            await tx`update allrice_conversation_runtimes set active_run_id=${nextRunId} where session_id=${f.session}`;
          });
          const next = await adapter.execute({
            ...executionInput,
            kernel: {
              ...executionInput.kernel,
              userMessageId: nextUserMessageId,
              assistantMessageId: nextAssistantMessageId,
              userRequest: 'ROOT_PRIVATE: follow up on the prior synthesis.',
            },
            assistants: productionAssistantController({
              ...controllerOptions!,
              worker: nextWorker,
              context: {
                ...controllerOptions!.context,
                executionId: randomUUID(),
                runId: nextRunId,
                jobId: nextJobId,
              },
            }),
          });
          expect(adapter.runtimeInventory()[0]?.id).toBe(previousRuntime!.id);
          expect(next).toMatchObject({
            assistantStatus: 'completed',
            usageComplete: true,
            costEstimateAvailable: false,
            cacheUsageKnown: false,
          });
          expect(next.answer).toContain('Root final synthesis');
          const nextTree = await f.runtime.getTree(f.context, {
            runId: nextRunId,
          });
          expect(nextTree.instances).toHaveLength(1);
          expect(nextTree.instances[0]).toMatchObject({
            runId: nextRunId,
            nativeSessionId,
            status: 'completed',
            stoppedAt: expect.any(String),
          });
          expect(nextTree.results).toHaveLength(0);
          expect(nextTree.messages).toHaveLength(0);
          expect(
            nextTree.budgets.find((b) => b.metric === 'model_calls')!.spent,
          ).toBe(1);
          expect(await bridge.tree()).toEqual(tree);
        } finally {
          overlap.release();
          completionReleased.release();
          await adapter.close();
          await model.close();
          vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
        }
      },
      60000,
    );
  },
);
