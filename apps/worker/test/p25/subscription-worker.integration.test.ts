/** Actual ordinary Worker + isolated PG; native acquisition is forbidden and
 * the adapter supplies synthetic usage. No provider or credential is read. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { executeEmployeeRun } from '../../src/jobs/employee-run.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.ts';
import type { DshRuntime } from '../../src/harness/dsh/runtime-pool.ts';
import * as AssistantController from '../../src/harness/dsh/assistant-controller.ts';
import { DshStartupRejection } from '../../src/harness/dsh/startup-rejection.ts';
import { attachAssistantFailureUsage } from '../../src/harness/dsh/assistant-outcome.ts';
import { HandlerError } from '../../src/errors.ts';
import { prepareExecutionIsolation } from '../../src/isolation.ts';
import {
  getOrganizationModelQuota,
  assertQuotaAvailable,
  createTraceableMemory,
} from '@allrice/database';
import type * as Database from '@allrice/database';
import {
  CodexSubscriptionQuotaSnapshotSchema,
  type PromptImageAttachment,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';
import { assistantSubscriptionSnapshotDigest } from '../../src/assistant-pricing-preflight.ts';

const status = vi.hoisted(() => ({
  quota: undefined as unknown,
  frozenMemories: undefined as { id: string; content: string }[] | undefined,
}));
vi.mock('@allrice/database', async (original) => {
  const database = await original<typeof Database>();
  return {
    ...database,
    resolveEmployeeExecution: async (
      ...args: Parameters<typeof Database.resolveEmployeeExecution>
    ) => {
      const resolved = await database.resolveEmployeeExecution(...args);
      return status.frozenMemories
        ? {
            ...resolved,
            promptSnapshot: {
              ...resolved.promptSnapshot,
              memories: status.frozenMemories,
            },
          }
        : resolved;
    },
    getCodexProviderStatus: vi.fn(async () => ({
      status: 'connected',
      quota: status.quota,
    })),
  };
});
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'ordinary Worker subscription projection, no model I/O',
  { timeout: 30_000 },
  () => {
    beforeEach(() => {
      status.quota = undefined;
      status.frozenMemories = undefined;
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      // Any accidental subscription cash estimation would throw, not silently 0.
      vi.stubEnv(
        'ALLRICE_MODEL_PRICING_JSON',
        'invalid-never-parse-for-subscription',
      );
      vi.spyOn(DshRuntimePool.prototype, 'acquire').mockImplementation(
        async () => {
          throw Error('TEST_NATIVE_ACQUISITION_FORBIDDEN');
        },
      );
      vi.spyOn(DshHarnessAdapter.prototype, 'isConfigured').mockReturnValue(
        true,
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    it.each([
      'complete',
      'personal_profile_writable',
      'personal_profile_with_assistants',
      'personal_method_with_assistants',
      'personal_profile_read_only',
      'image_with_assistants',
      'image_generation_with_assistants',
      'transport_failure',
      'mismatched_result',
      'missing_usage',
      'quota_exhausted',
      'startup_undispatched',
      'startup_other_run',
      'startup_other_attempt',
      'startup_forged',
      'failed_known_usage',
      'failed_unknown_usage',
      'failed_foreign_usage',
    ])(
      'writes trustworthy subscription N/A and preserves admission for %s',
      async (mode) => {
        const unknownUsage = ![
          'complete',
          'personal_profile_writable',
          'personal_profile_with_assistants',
          'personal_method_with_assistants',
          'personal_profile_read_only',
          'quota_exhausted',
          'image_with_assistants',
          'image_generation_with_assistants',
          'startup_undispatched',
          'failed_known_usage',
        ].includes(mode);
        const temporary = await mkdtemp(
          join(tmpdir(), 'allrice-subscription-worker-test-'),
        );
        // Explicit test-only opt-in; the fixture still accepts only its exact
        // local/CI database URLs. Live Codex smoke callers retain the local pin.
        const fixture = await createP27CodexWorkerFixture({
          allowCiDatabase: true,
          syntheticImagesWithAssistants: mode === 'image_with_assistants',
          imageGeneration: mode === 'image_generation_with_assistants',
          imageGenerationAssistants:
            mode === 'image_generation_with_assistants',
          personalProfile: [
            'personal_profile_with_assistants',
            'personal_method_with_assistants',
          ].includes(mode)
            ? 'writable_with_assistants'
            : mode === 'personal_profile_writable'
              ? 'writable'
              : mode === 'personal_profile_read_only'
                ? 'read_only'
                : undefined,
        });
        let cleanup: (() => Promise<void>) | undefined;
        try {
          vi.stubEnv('ALLRICE_STORAGE_ROOT', join(temporary, 'storage'));
          const png =
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC';
          let images: PromptImageAttachment[] | undefined;
          if (mode === 'image_with_assistants') {
            // Exercise the production Worker image loader and billing/controller
            // wiring with an image captured in the initial immutable snapshot.
            vi.stubEnv(
              'ALLRICE_ASSISTANT_PRICING_JSON',
              'never-parse-for-subscription-images',
            );
            const bytes = Buffer.from(png, 'base64'),
              id = randomUUID();
            const image: PromptImageAttachment = {
              fileName: 'chart.png',
              object: {
                id,
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                ownerId: fixture.ownerId,
                key: `organizations/${fixture.organizationId}/workspaces/${fixture.workspaceId}/owners/${fixture.ownerId}/uploads/${id}`,
                mediaType: 'image/png',
                sizeBytes: bytes.length,
                checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                immutable: true,
                retentionUntil: null,
                deletedAt: null,
              },
            };
            await new LocalStorageAdapter(join(temporary, 'storage')).put(
              image.object,
              new ReadableStream({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
            );
            images = [image];
          }
          const task = await fixture.prepareOrdinaryTask(
            mode === 'personal_method_with_assistants'
              ? '请保存我的工作场景候选：每周核对数据。'
              : mode.startsWith('personal_profile')
                ? '请把你的名字改为小禾。以后回答保持简洁。'
                : 'Synthetic arithmetic.',
            images,
          );
          if (mode === 'complete') {
            const [source] =
              await fixture.db`select user_message_id from allrice_employee_runs where run_id=${task.runId}`;
            const draftMemory = await createTraceableMemory(fixture.context, {
              workspaceId: fixture.workspaceId,
              content: 'QUEUED_DRAFT_MEMORY',
              visibility: 'private',
              sourceType: 'message',
              sourceId: source!.user_message_id,
              sourceLabel: 'Synthetic prior discussion',
              lifecycleState: 'durable',
              memoryClass: 'user_preference',
              confidence: 1,
              expiresAt: null,
            });
            const ordinaryMemory = await createTraceableMemory(
              fixture.context,
              {
                workspaceId: fixture.workspaceId,
                content: 'ORDINARY_MEMORY_RETAINED',
                visibility: 'private',
                sourceType: 'user',
                sourceId: null,
                sourceLabel: 'Synthetic ordinary preference',
                lifecycleState: 'durable',
                memoryClass: 'user_preference',
                confidence: 1,
                expiresAt: null,
              },
            );
            // The queue ordering is covered in the DB integration; this exercises
            // the actual Worker sink with a frozen, now-ineligible memory.
            // Supply the already-frozen array at the resolver test boundary;
            // never rewrite production-protected immutable snapshot columns.
            status.frozenMemories = [
              { id: draftMemory.id, content: draftMemory.content },
              { id: ordinaryMemory.id, content: ordinaryMemory.content },
            ];
            await fixture.db`update allrice_employee_runs set method_authoring=true where run_id=${task.runId}`;
          }
          if (
            images ||
            mode === 'image_generation_with_assistants' ||
            [
              'personal_profile_with_assistants',
              'personal_method_with_assistants',
            ].includes(mode)
          )
            vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
          if (mode === 'image_generation_with_assistants')
            vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
          const isolation = await prepareExecutionIsolation({
            root: temporary,
            organizationId: fixture.organizationId,
            workspaceId: fixture.workspaceId,
            ownerId: fixture.ownerId,
            runId: task.runId,
            jobId: task.workflowLease.jobId,
            attempt: 1,
          });
          cleanup = isolation.cleanup;
          if (mode === 'quota_exhausted')
            status.quota = CodexSubscriptionQuotaSnapshotSchema.parse({
              source: 'codex_app_server',
              status: 'available',
              checkedAt: new Date().toISOString(),
              accountFingerprint: `sha256:${'a'.repeat(64)}`,
              detailCode: 'codex_quota_available',
              buckets: [
                {
                  limitId: 'codex',
                  limitReached: true,
                  windows: [
                    {
                      slot: 'primary',
                      status: 'available',
                      usedPercent: 100,
                      windowDurationMins: 300,
                      resetsAt: Math.floor(Date.now() / 1000) + 3600,
                    },
                    {
                      slot: 'secondary',
                      status: 'unknown',
                      usedPercent: null,
                      windowDurationMins: null,
                      resetsAt: null,
                    },
                  ],
                },
              ],
            });
          const nativePrompt = vi.fn(async () => {
            throw Error('TEST_MODEL_DISPATCH_FORBIDDEN');
          });
          const nativeAssistant = vi.fn(async () => {
            throw Error('TEST_NATIVE_ASSISTANT_BIND_FORBIDDEN');
          });
          if (mode === 'startup_undispatched') {
            // Exercise the actual adapter -> Worker -> PG classification. Only
            // the local controller rejection/empty host are fault-injected;
            // no native prompt, credential or model can be reached.
            vi.mocked(DshRuntimePool.prototype.acquire).mockResolvedValue({
              runtime: {
                client: { prompt: nativePrompt, assistant: nativeAssistant },
              } as unknown as DshRuntime,
              fresh: true,
              preparation: {
                cache: 'miss',
                reason: 'not_resident',
                changedFields: [],
                credentialResolutionMs: 0,
                previousRuntimeCloseMs: 0,
                initializeMs: 0,
                skillRegistrationMs: null,
                acquireMs: 0,
              },
            });
            vi.spyOn(DshRuntimePool.prototype, 'drop').mockResolvedValue();
            vi.spyOn(
              AssistantController,
              'productionAssistantController',
            ).mockImplementation((input) => ({
              deliveryMode: input.deliveryMode,
              rootRunId: input.context.runId,
              subscriptionSnapshot: input.subscriptionSnapshot,
              bind: async () => {
                throw Error('synthetic bind rejected before prompt');
              },
            }));
          }
          const originalExecute = DshHarnessAdapter.prototype.execute;
          const execute = vi
            .spyOn(DshHarnessAdapter.prototype, 'execute')
            .mockImplementation(async function (
              this: DshHarnessAdapter,
              input,
            ) {
              if (mode === 'startup_undispatched')
                return originalExecute.call(this, input);
              if (mode === 'complete') {
                expect(input.kernel.authorizedMemoryContext).not.toContain(
                  'QUEUED_DRAFT_MEMORY',
                );
                expect(input.kernel.authorizedMemoryContext).toContain(
                  'ORDINARY_MEMORY_RETAINED',
                );
              }
              const profileTool = 'workspace.employee.profile.update';
              if (
                mode === 'personal_profile_writable' ||
                mode === 'personal_profile_with_assistants'
              ) {
                let bridge:
                  | Awaited<
                      ReturnType<NonNullable<typeof input.assistants>['bind']>
                    >
                  | undefined;
                if (mode === 'personal_profile_with_assistants') {
                  bridge = await input.assistants!.bind(
                    `dsh-${task.sessionId}`,
                    input.generation,
                    input.onToolCall,
                  );
                  expect(await bridge.cancellation()).toBeDefined();
                  const [assistant] =
                    await fixture.db`select allowed_tools from allrice_assistant_instances where run_id=${task.runId}`;
                  expect(assistant?.allowed_tools).toContain(
                    'assistant.delegate',
                  );
                  expect(assistant?.allowed_tools).toContain(profileTool);
                }
                // Exercise the actual frozen binding -> Worker -> adapter
                // envelope and Broker write, without any model or credential.
                expect(input.tools?.map((tool) => tool.name)).toContain(
                  profileTool,
                );
                expect(input.authorizedToolNames).toContain(profileTool);
                const call = {
                  id: 'synthetic-profile-update',
                  name: profileTool,
                  arguments: {
                    expectedRevision: 1,
                    name: '小禾',
                    expressionStyle: 'concise',
                  },
                };
                const receipt = bridge
                  ? await bridge.handle('tool', {
                      nativeSessionId: `dsh-${task.sessionId}`,
                      callId: call.id,
                      name: call.name,
                      arguments: call.arguments,
                    })
                  : await input.onToolCall!(call);
                expect(JSON.parse(String(receipt.modelContent))).toMatchObject({
                  revision: 2,
                  profile: { name: '小禾', expressionStyle: 'concise' },
                });
                const [saved] = await fixture.db`select i.revision,i.profile
                  from allrice_employee_instances i join allrice_chat_sessions s
                    on s.employee_instance_id=i.id where s.id=${task.sessionId}`;
                expect(saved).toMatchObject({
                  revision: 2,
                  profile: { name: '小禾', expressionStyle: 'concise' },
                });
                expect(task.binding.executionSnapshot.instance?.revision).toBe(
                  1,
                );
                if (bridge) {
                  const usage =
                    await fixture.db`select amount,settled_amount from allrice_assistant_usage where run_id=${task.runId} and metric='tool_calls'`;
                  expect(usage).toHaveLength(1);
                  expect(Number(usage[0]!.amount)).toBe(1);
                  expect(Number(usage[0]!.settled_amount)).toBe(1);
                  await expect(
                    bridge.handle('tool', {
                      nativeSessionId: `dsh-${task.sessionId}`,
                      callId: call.id,
                      name: call.name,
                      arguments: call.arguments,
                    }),
                  ).rejects.toThrow('assistant_tool_unknown_no_replay');
                }
              } else if (mode === 'image_generation_with_assistants') {
                // This general employee has storage:write. It can persist its
                // owner's expression preference but cannot edit work methods.
                expect(input.tools?.map((tool) => tool.name)).toContain(
                  profileTool,
                );
                expect(
                  input.tools?.filter((tool) =>
                    tool.name.startsWith('workspace.employee.method.'),
                  ),
                ).toEqual([]);
              } else if (mode !== 'personal_method_with_assistants') {
                expect(input.tools?.map((tool) => tool.name)).not.toContain(
                  profileTool,
                );
              }
              if (mode === 'personal_method_with_assistants') {
                const bridge = await input.assistants!.bind(
                  `dsh-${task.sessionId}`,
                  input.generation,
                  input.onToolCall,
                );
                const inspectTool = 'workspace.employee.method.inspect',
                  saveTool = 'workspace.employee.method.save_candidate';
                expect(input.tools?.map((t) => t.name)).toEqual(
                  expect.arrayContaining([inspectTool, saveTool]),
                );
                expect(input.authorizedToolNames).toEqual(
                  expect.arrayContaining([inspectTool, saveTool]),
                );
                for (const stage of [
                  'test',
                  'test_status',
                  'prepare_activation',
                  'activate',
                ])
                  expect(input.authorizedToolNames).not.toContain(
                    `workspace.employee.method.${stage}`,
                  );
                const call = (name: string, callId: string, args: unknown) =>
                  bridge.handle('tool', {
                    nativeSessionId: `dsh-${task.sessionId}`,
                    name,
                    callId,
                    arguments: args,
                  });
                expect(
                  JSON.parse(
                    String(
                      (
                        await call(inspectTool, 'inspect-candidate', {
                          view: 'candidate',
                        })
                      ).modelContent,
                    ),
                  ),
                ).toMatchObject({ revision: 0 });
                const saved = await call(saveTool, 'save-method', {
                  expectedRevision: 0,
                  section: 'scene',
                  scene: { name: '每周核对', appliesWhen: '每周' },
                  procedure: '先核对原始数据',
                  changeSummary: '新增周核对',
                });
                const receipt = JSON.parse(String(saved.modelContent));
                expect(receipt).toMatchObject({
                  revision: 1,
                  enabled: true,
                  status: 'saved',
                });
                expect(receipt.active).toEqual(receipt.candidate);
                const [row] =
                  await fixture.db`select s.revision,s.candidate_revision_id,s.active_revision_id from allrice_employee_content_sets s
                  join allrice_chat_sessions c on c.employee_instance_id=s.instance_id where c.id=${task.sessionId}`;
                expect(row).toMatchObject({
                  revision: 1,
                  candidate_revision_id: receipt.candidate.id,
                  active_revision_id: receipt.candidate.id,
                });
                const usage =
                  await fixture.db`select amount,settled_amount from allrice_assistant_usage where run_id=${task.runId} and metric='tool_calls'`;
                expect(usage).toHaveLength(2);
                expect(
                  usage.every(
                    (u) =>
                      Number(u.amount) === 1 && Number(u.settled_amount) === 1,
                  ),
                ).toBe(true);
              }
              if (mode === 'image_generation_with_assistants') {
                expect(input.tools?.map((t) => t.name)).toEqual(
                  expect.arrayContaining([
                    'image.generate',
                    'image.edit',
                    'assistant.delegate',
                  ]),
                );
                const bridge = await input.assistants!.bind(
                  `dsh-${task.sessionId}`,
                  input.generation,
                  input.onToolCall,
                );
                await expect(bridge.cancellation()).resolves.toBeDefined();
              }
              if (mode === 'image_with_assistants') {
                expect(input.images).toEqual([
                  { mediaType: 'image/png', data: png, name: 'chart.png' },
                ]);
                expect(input.assistants?.subscriptionSnapshot).toMatchObject({
                  billingMode: 'subscription',
                });
              }
              if (mode === 'transport_failure')
                throw Error('synthetic transport failed after dispatch');
              if (mode.startsWith('failed_')) {
                const error = new HandlerError(
                  'ASSISTANT_BUDGET_EXHAUSTED',
                  'synthetic internal budget stop',
                  false,
                );
                attachAssistantFailureUsage(
                  error,
                  mode === 'failed_foreign_usage' ? 'another-run' : task.runId,
                  input.attempt,
                  {
                    usage: {
                      inputTokens: 47002,
                      outputTokens: 3214,
                      cachedInputTokens: 0,
                    },
                    usageComplete: mode !== 'failed_unknown_usage',
                    cacheUsageKnown: false,
                  },
                );
                throw error;
              }
              if (mode.startsWith('startup_')) {
                const original = Error('synthetic bind rejected before prompt');
                if (mode === 'startup_forged')
                  throw Object.assign(original, {
                    name: 'DshStartupRejection',
                    undispatched: true,
                    runId: task.runId,
                    attempt: input.attempt,
                  });
                throw new DshStartupRejection(
                  original,
                  mode === 'startup_other_run' ? 'other-run' : task.runId,
                  mode === 'startup_other_attempt'
                    ? input.attempt + 1
                    : input.attempt,
                );
              }
              return {
                answer: 'Synthetic',
                provider: 'openai-codex',
                model:
                  mode === 'mismatched_result'
                    ? 'unverified-model'
                    : 'gpt-5.6-luna',
                usage: {
                  inputTokens: 10,
                  cachedInputTokens: 2,
                  outputTokens: 3,
                },
                usageComplete: mode === 'missing_usage' ? undefined : true,
                cacheUsageKnown: mode === 'missing_usage' ? undefined : true,
                ...([
                  'image_with_assistants',
                  'image_generation_with_assistants',
                  'personal_profile_with_assistants',
                  'personal_method_with_assistants',
                ].includes(mode)
                  ? {
                      assistantStatus: 'completed' as const,
                      billingMode: 'subscription' as const,
                      costBasis: 'not_applicable' as const,
                      estimatedCostCents: null,
                      costEstimateAvailable: false,
                      actualCostKnown: false as const,
                      cacheUsageKnown: false,
                      subscriptionSnapshotDigest:
                        assistantSubscriptionSnapshotDigest(
                          input.assistants!.subscriptionSnapshot!,
                        ),
                    }
                  : {}),
              };
            });
          const pending = executeEmployeeRun({
            execution: task.execution,
            isolation,
            signal: new AbortController().signal,
            onHarnessEvent: async () => {},
            workflowLease: task.workflowLease,
          });
          if (mode.startsWith('failed_'))
            await expect(pending).rejects.toMatchObject({
              code: 'ASSISTANT_BUDGET_EXHAUSTED',
              retryable: false,
            });
          else if (mode.startsWith('startup_'))
            await expect(pending).rejects.toThrow(
              'synthetic bind rejected before prompt',
            );
          else if (mode === 'transport_failure')
            await expect(pending).rejects.toThrow('synthetic transport failed');
          else if (mode === 'mismatched_result')
            await expect(pending).rejects.toMatchObject({
              code: 'ASSISTANT_SUBSCRIPTION_RESULT_UNVERIFIED',
            });
          else
            expect(await pending).toMatchObject({
              billingMode: 'subscription',
              costBasis: 'not_applicable',
              estimatedCostCents: null,
              costEstimateAvailable: false,
              actualCostKnown: false,
              subscriptionSnapshotDigest: expect.stringMatching(/^sha256:/),
              usage: { inputTokens: 10, outputTokens: 3 },
            });
          expect(execute).toHaveBeenCalledTimes(1);
          expect(DshRuntimePool.prototype.acquire).toHaveBeenCalledTimes(
            mode === 'startup_undispatched' ? 1 : 0,
          );
          expect(nativePrompt).not.toHaveBeenCalled();
          expect(nativeAssistant).not.toHaveBeenCalled();
          const [ledger] =
            await fixture.db`select l.cost_cents,l.usage_complete,l.input_tokens,l.cached_input_tokens,l.output_tokens,s.snapshot_digest
        from allrice_model_usage_ledger l join allrice_route_subscription_snapshots s on s.route_decision_id=l.route_decision_id`;
          expect(ledger).toMatchObject({
            cost_cents: null,
            usage_complete: !unknownUsage,
            snapshot_digest: expect.stringMatching(/^sha256:/),
          });
          if (['failed_known_usage', 'failed_unknown_usage'].includes(mode))
            expect(ledger).toMatchObject({
              input_tokens: 47002,
              output_tokens: 3214,
              cached_input_tokens: 0,
            });
          if (mode === 'failed_foreign_usage')
            expect(ledger).toMatchObject({ input_tokens: 0, output_tokens: 0 });
          const quota = await getOrganizationModelQuota(
            fixture.organizationId,
            fixture.db,
          );
          expect(quota).toMatchObject({
            unknownCostRuns: 0,
            subscriptionRuns: 1,
            usageComplete: !unknownUsage,
          });
          if (mode === 'startup_undispatched') {
            expect(ledger).toMatchObject({
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
            });
            const [decision] =
              await fixture.db`select status,error_code from allrice_route_decisions`;
            expect(decision).toMatchObject({
              status: 'failed',
              error_code: 'CONVERSATION_FAILED',
            });
          }
          // Unknown accounting must stay unknown, but no longer locks the account.
          expect(() =>
            assertQuotaAvailable(quota, 'subscription'),
          ).not.toThrow();
        } finally {
          await cleanup?.();
          expect(await fixture.close()).toMatchObject({
            globalDatabaseClosed: true,
            databaseEnvironmentRestored: true,
            fixture: {
              schemaRemoved: true,
              storageRemoved: true,
              databaseClosed: true,
              adminClosed: true,
            },
          });
          await rm(temporary, { recursive: true, force: true });
        }
      },
    );
  },
);
