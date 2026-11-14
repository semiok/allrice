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
import { DshStartupRejection } from '../../src/harness/dsh/startup-rejection.ts';
import { attachExecutionFailureUsage } from '../../src/harness/dsh/execution-failure-usage.ts';
import { HandlerError } from '../../src/errors.ts';
import { prepareExecutionIsolation } from '../../src/isolation.ts';
import {
  getOrganizationModelQuota,
  assertQuotaAvailable,
  createTraceableMemory,
  prepareEmployeeRunBinding,
  enqueueRun,
  claimNextJob,
  startClaimedJob,
  cancelRun,
  completeJob,
} from '@allrice/database';
import type * as Database from '@allrice/database';
import {
  CodexSubscriptionQuotaSnapshotSchema,
  EmployeePromptSnapshotSchema,
  RunMemoryContextV2StateSchema,
  type PromptImageAttachment,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';

const status = vi.hoisted(() => ({
  quota: undefined as unknown,
}));
vi.mock('@allrice/database', async (original) => {
  const database = await original<typeof Database>();
  return {
    ...database,
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
      'progress_waiting',
      'progress_missing',
      'progress_canceled',
      'personal_profile_writable',
      'general_profile_writable',
      'personal_method',
      'personal_profile_read_only',
      'image',
      'image_generation',
      'transport_failure',
      'mismatched_result',
      'missing_usage',
      'quota_exhausted',
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
          'general_profile_writable',
          'personal_method',
          'personal_profile_read_only',
          'quota_exhausted',
          'image',
          'image_generation',
          'failed_known_usage',
        ].includes(mode);
        const temporary = await mkdtemp(
          join(tmpdir(), 'allrice-subscription-worker-test-'),
        );
        // Explicit test-only opt-in; the fixture still accepts only its exact
        // local/CI database URLs. Live Codex smoke callers retain the local pin.
        const fixture = await createP27CodexWorkerFixture({
          allowCiDatabase: true,
          syntheticImages: mode === 'image',
          imageGeneration: [
            'image_generation',
            'general_profile_writable',
          ].includes(mode),
          personalProfile: ['personal_method'].includes(mode)
            ? 'writable'
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
          if (mode === 'image') {
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
          let ordinaryMemoryId: string | undefined;
          if (mode === 'complete') {
            await fixture.db`insert into allrice_sessions(id,user_id,token_hash,expires_at) values(${fixture.context.sessionId},${fixture.context.actor.id},${createHash('sha256').update(randomUUID()).digest('hex')},now()+interval '1 hour')`;
            // Prepare an independent prior source before the target admission.
            // Never replace the target's frozen documents or memory allowance.
            const sessionId = randomUUID(),
              userMessageId = randomUUID(),
              assistantMessageId = randomUUID();
            await fixture.db.begin(async (tx) => {
              await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
                values(${sessionId},${fixture.organizationId},${fixture.workspaceId},${fixture.ownerId},'Synthetic prior discussion',${fixture.assignmentId},${fixture.employeeVersionId})`;
              await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
                values(${userMessageId},${fixture.organizationId},${fixture.workspaceId},${sessionId},${fixture.ownerId},'user','{"text":"Synthetic prior discussion.","citations":[]}'),
                  (${assistantMessageId},${fixture.organizationId},${fixture.workspaceId},${sessionId},${fixture.ownerId},'assistant','{"text":"","citations":[]}')`;
            });
            const binding = await prepareEmployeeRunBinding({
              employeeDocuments: true,
              context: fixture.context,
              workspaceId: fixture.workspaceId,
              assignmentId: fixture.assignmentId,
              employeeVersionId: fixture.employeeVersionId,
              sessionId,
              userMessageId,
              assistantMessageId,
              promptSnapshot: {
                systemPrompt: '',
                userRequest: 'Synthetic prior discussion.',
                conversation: [],
                memories: [],
              },
            });
            const prior = await enqueueRun(
              fixture.context,
              {
                workspaceId: fixture.workspaceId,
                idempotencyKey: randomUUID(),
                type: 'allrice.employee.run',
                maxAttempts: 1,
                timeoutMs: binding.executionSnapshot.runtimePolicy.timeoutMs,
                input: {
                  employeeAssignmentId: fixture.assignmentId,
                  employeeVersionId: fixture.employeeVersionId,
                  sessionId,
                  userMessageId,
                  assistantMessageId,
                },
              },
              { employeeBinding: binding },
            );
            const workerId = randomUUID();
            const job = await claimNextJob(workerId, 30_000);
            if (!job?.lease) throw Error('TEST_PRIOR_SOURCE_LEASE_MISSING');
            const [expectedJob] =
              await fixture.db`select id from allrice_jobs where run_id=${prior.run.id}`;
            expect(job.id).toBe(expectedJob?.id);
            const execution = await startClaimedJob(
              workerId,
              job.id,
              job.lease.token,
            );
            expect(execution?.context.runId).toBe(prior.run.id);
            const draftMemory = await createTraceableMemory(fixture.context, {
              workspaceId: fixture.workspaceId,
              content: 'QUEUED_DRAFT_MEMORY',
              visibility: 'private',
              sourceType: 'message',
              sourceId: userMessageId,
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
                instanceId: draftMemory.instanceId!,
                idempotencyKey: randomUUID(),
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
            ordinaryMemoryId = ordinaryMemory.id;
            // Preserve the late method-source exclusion scenario, then close
            // this owned lease without dispatching a model or native runtime.
            await fixture.db`update allrice_employee_runs set method_authoring=true where run_id=${prior.run.id}`;
            await cancelRun(
              fixture.context,
              fixture.workspaceId,
              prior.run.id,
              { reason: 'Synthetic prior source history' },
            );
            await completeJob({
              workerId,
              jobId: job.id,
              leaseToken: job.lease.token,
              result: {},
            });
            const [history] =
              await fixture.db`select r.state,j.status,j.lease_token,e.status employee_status,e.method_authoring
                from allrice_runs r join allrice_jobs j on j.run_id=r.id
                join allrice_employee_runs e on e.run_id=r.id where r.id=${prior.run.id}`;
            expect(history).toMatchObject({
              state: 'canceled',
              status: 'canceled',
              lease_token: null,
              employee_status: 'canceled',
              method_authoring: true,
            });
          }
          const task = await fixture.prepareOrdinaryTask(
            mode === 'personal_method'
              ? '请保存我的工作场景候选：每周核对数据。'
              : mode === 'general_profile_writable'
                ? '请记住我喜欢简短回答。'
                : mode.startsWith('personal_profile')
                  ? '往后就叫你小禾，回复也短一点，记下来。'
                  : mode.startsWith('progress_')
                    ? '连续失败了，先暂停，等我确认后再继续。'
                    : 'Synthetic arithmetic.',
            images,
          );
          if (mode === 'complete') {
            const [frozen] =
              await fixture.db`select prompt_snapshot,memory_context_state,method_authoring
                from allrice_employee_runs where run_id=${task.runId}`;
            const prompt = EmployeePromptSnapshotSchema.parse(
              frozen?.prompt_snapshot,
            );
            const memory = RunMemoryContextV2StateSchema.parse(
              frozen?.memory_context_state,
            );
            expect(frozen?.method_authoring).toBe(false);
            expect(prompt.employeeDocuments).toMatchObject({
              schemaVersion: 2,
            });
            expect(prompt.memories).toEqual([]);
            expect(memory.pins.map((pin) => pin.id)).toEqual([
              ordinaryMemoryId,
            ]);
          }
          if (
            images ||
            mode === 'image_generation' ||
            ['personal_method'].includes(mode)
          )
            vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
          if (mode === 'image_generation')
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
          const execute = vi
            .spyOn(DshHarnessAdapter.prototype, 'execute')
            .mockImplementation(async function (
              this: DshHarnessAdapter,
              input,
            ) {
              if (mode === 'complete') {
                expect(input.kernel.employeeDocuments?.memory).not.toContain(
                  'QUEUED_DRAFT_MEMORY',
                );
                expect(input.kernel.employeeDocuments?.memory).toContain(
                  'ORDINARY_MEMORY_RETAINED',
                );
              }
              const profileTool = 'workspace.employee.profile.update';
              if (
                [
                  'personal_profile_writable',
                  'general_profile_writable',
                ].includes(mode)
              ) {
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
                    ...(mode === 'personal_profile_writable'
                      ? { name: '小禾' }
                      : {}),
                    expressionStyle: 'concise',
                  },
                };
                const receipt = await input.onToolCall!(call);
                expect(JSON.parse(String(receipt.modelContent))).toMatchObject({
                  revision: 2,
                  profile: {
                    ...(mode === 'personal_profile_writable'
                      ? { name: '小禾' }
                      : {}),
                    expressionStyle: 'concise',
                  },
                  effectiveFrom: 'next_task',
                  receipt: receipt.summary,
                });
                expect(receipt.summary).toContain('默认表达方式：简洁');
                expect(receipt.summary).toContain('下个任务起生效');
                expect(receipt.summary).toContain('你可以再说一句改回去');
                if (mode === 'personal_profile_writable')
                  expect(receipt.summary).toContain('个人名称：小禾');
                const [saved] = await fixture.db`select i.revision,i.profile
                  from allrice_employee_instances i join allrice_chat_sessions s
                    on coalesce(s.employee_instance_id,s.employee_assignment_id)=i.id where s.id=${task.sessionId}`;
                expect(saved).toMatchObject({
                  revision: 2,
                  profile: {
                    ...(mode === 'personal_profile_writable'
                      ? { name: '小禾' }
                      : {}),
                    expressionStyle: 'concise',
                  },
                });
                expect(task.binding.executionSnapshot.instance?.revision).toBe(
                  1,
                );
              } else if (mode === 'image_generation') {
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
              } else if (mode !== 'personal_method') {
                expect(input.tools?.map((tool) => tool.name)).not.toContain(
                  profileTool,
                );
              }
              if (mode === 'personal_method') {
                for (const names of [
                  input.tools?.map((t) => t.name),
                  input.authorizedToolNames,
                ])
                  expect(
                    names?.filter((name) =>
                      name.startsWith('workspace.employee.method.'),
                    ),
                  ).toEqual([]);
                const before =
                  await fixture.db`select s.revision,s.candidate_revision_id,s.active_revision_id from allrice_employee_content_sets s
                  join allrice_chat_sessions c on c.employee_instance_id=s.instance_id where c.id=${task.sessionId}`;
                for (const [action, args] of [
                  ['inspect', { view: 'candidate' }],
                  [
                    'save_candidate',
                    {
                      expectedRevision: 0,
                      section: 'scene',
                      scene: { name: '每周核对', appliesWhen: '每周' },
                      procedure: '先核对原始数据',
                      changeSummary: '新增周核对',
                    },
                  ],
                  [
                    'restore_candidate',
                    {
                      expectedRevision: 0,
                      sourceRevisionId: randomUUID(),
                      changeSummary: '恢复旧方法',
                    },
                  ],
                ] as const) {
                  await expect(
                    input.onToolCall!({
                      name: `workspace.employee.method.${action}`,
                      id: `ungranted-${action}`,
                      arguments: args,
                    }),
                  ).rejects.toMatchObject({ code: 'TOOL_NOT_ALLOWED' });
                }
                const after =
                  await fixture.db`select s.revision,s.candidate_revision_id,s.active_revision_id from allrice_employee_content_sets s
                  join allrice_chat_sessions c on c.employee_instance_id=s.instance_id where c.id=${task.sessionId}`;
                expect(after).toEqual(before);
                const [run] =
                  await fixture.db`select method_authoring from allrice_employee_runs where run_id=${task.runId}`;
                expect(run!.method_authoring).toBe(false);
              }
              if (mode === 'image_generation') {
                expect(input.tools?.map((t) => t.name)).toEqual(
                  expect.arrayContaining(['image.generate', 'image.edit']),
                );
              }
              if (mode === 'image') {
                expect(input.images).toEqual([
                  { mediaType: 'image/png', data: png, name: 'chart.png' },
                ]);
              }
              if (mode === 'transport_failure')
                throw Error('synthetic transport failed after dispatch');
              if (mode.startsWith('failed_')) {
                const error = new HandlerError(
                  'ASSISTANT_BUDGET_EXHAUSTED',
                  'synthetic internal budget stop',
                  false,
                );
                attachExecutionFailureUsage(
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
              if (mode.startsWith('progress_')) {
                const port = input.progress!;
                const nativeSessionId = `dsh-${task.sessionId}`;
                if (mode !== 'progress_missing') {
                  for (let i = 0; i < 3; i++) {
                    await port({
                      action: 'start',
                      kind: 'tool',
                      nativeSessionId,
                      callId: `error-${i}`,
                      name: 'read',
                      argumentsDigest: `sha256:${'a'.repeat(64)}`,
                    });
                    await port({
                      action: 'finish',
                      kind: 'tool',
                      nativeSessionId,
                      callId: `error-${i}`,
                      outcome: 'error',
                      resultDigest: `sha256:${'b'.repeat(64)}`,
                    });
                  }
                  if (mode === 'progress_canceled') {
                    const paused = await port({
                      action: 'check',
                      nativeSessionId,
                    });
                    await port({
                      action: 'decide',
                      nativeSessionId,
                      pauseId: paused.pauseId,
                      decision: 'cancel',
                    });
                  }
                }
              }
              return {
                ...(mode.startsWith('progress_')
                  ? {
                      waitingForUser: {
                        questionId: 'structured-progress-question',
                      },
                      threadId: `dsh-${task.sessionId}`,
                    }
                  : {}),
                answer: 'Synthetic',
                provider: 'openai-codex',
                model:
                  mode === 'mismatched_result'
                    ? 'unverified-model'
                    : task.binding.executionSnapshot.modelSnapshot!.model,
                usage: {
                  inputTokens: 10,
                  cachedInputTokens: 2,
                  outputTokens: 3,
                },
                usageComplete: mode === 'missing_usage' ? undefined : true,
                cacheUsageKnown: mode === 'missing_usage' ? undefined : true,
              };
            });
          const pending = executeEmployeeRun({
            execution: task.execution,
            isolation,
            signal: new AbortController().signal,
            onHarnessEvent: async () => {},
            workflowLease: task.workflowLease,
          });
          if (mode.startsWith('progress_')) {
            if (mode === 'progress_missing') {
              await expect(pending).rejects.toMatchObject({
                code: 'DSH_TURN_FAILED',
              });
            } else if (mode === 'progress_canceled') {
              await expect(pending).rejects.toThrow('task_progress_lease_lost');
            } else {
              const result = await pending;
              expect(result).toMatchObject({
                answer: '等你回答后继续。',
                waitingForUser: { questionId: 'structured-progress-question' },
              });
              await completeJob({ ...task.workflowLease, result });
              const [run] =
                await fixture.db`select r.state,j.status,j.lease_token,e.experience_capture_state,p.pause_id,p.canceled from allrice_runs r join allrice_jobs j on j.run_id=r.id join allrice_employee_runs e on e.run_id=r.id join allrice_task_progress p on p.run_id=r.id where r.id=${task.runId}`;
              expect(run).toMatchObject({
                state: 'succeeded',
                status: 'succeeded',
                lease_token: null,
                experience_capture_state: null,
                canceled: false,
                pause_id: expect.any(String),
              });
              const decisions =
                await fixture.db`select * from allrice_task_progress_decisions where run_id=${task.runId}`;
              expect(decisions).toHaveLength(0);
              const [event] =
                await fixture.db`select payload from allrice_run_events where run_id=${task.runId} and event_type='run.succeeded'`;
              expect(event!.payload.result.waitingForUser).toEqual({
                questionId: 'structured-progress-question',
              });
            }
            return;
          }
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
          expect(DshRuntimePool.prototype.acquire).toHaveBeenCalledTimes(0);
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
