/** Real queue/progress ledger + production adapter and native Host; loopback model.
 * Worker finalization is separately exercised in subscription-worker.integration. */
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  claimNextJob,
  completeJob,
  enqueueRun,
  failJob,
  requestRunCancellationTransaction,
  startClaimedJob,
} from '../../../../packages/database/src/execution/queue.ts';
import { prepareEmployeeRunBinding } from '../../../../packages/database/src/employees/employeehub.ts';
import { createTaskProgressRuntime } from '../../../../packages/database/src/task-progress.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import type { HarnessExecutionInput } from '../../src/harness/adapter.ts';
import type { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.ts';
import { p24Fixture } from '../p24/fixture.ts';
import {
  acquireConversationRuntime,
  bindConversationThread,
  recordConversationTurn,
} from '../../../../packages/database/src/conversation/conversation-runtime.ts';
import {
  claimConversationSteer,
  consumeConversationSteer,
} from '../../../../packages/database/src/conversation/conversation-input.ts';
// Web uses bundler resolution; keep its real route outside worker's NodeNext graph.
const messageRoutePath =
  '../../../web/app/api/v1/sessions/[id]/messages/route.ts';
const { POST } = await import(messageRoutePath);
const browserAuth = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('../../../web/lib/identity/session', () => ({
  getRequestContext: browserAuth.context,
}));

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-210 scenarios 16, 27 and 28: durable program pause across Runs',
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let model: Awaited<ReturnType<typeof p24Fixture>>;
    const adapters: DshHarnessAdapter[] = [];
    afterEach(async () => {
      for (const adapter of adapters.splice(0)) await adapter.close();
      await model?.close();
      await f?.close();
      vi.unstubAllEnvs();
    });
    async function setup() {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
      });
      return f.prepareOrdinaryTask(
        '读取目录；如果连续失败，等我确认后再继续。',
      );
    }
    type Task = Awaited<ReturnType<typeof setup>>;
    function port(task: Task, sessionId: string | undefined = task.sessionId) {
      return createTaskProgressRuntime(
        {
          context: task.execution.context,
          worker: task.workflowLease,
          sessionId,
        },
        f.db,
      );
    }
    async function followUp(prior: Task, prompt: string) {
      const userMessageId = randomUUID(),
        assistantMessageId = randomUUID();
      await f.db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values
      (${userMessageId},${f.organizationId},${f.workspaceId},${prior.sessionId},${f.ownerId},'user',${f.db.json({ text: prompt, citations: [] })}),
      (${assistantMessageId},${f.organizationId},${f.workspaceId},${prior.sessionId},${f.ownerId},'assistant','{"text":"","citations":[]}')`;
      const binding = await prepareEmployeeRunBinding({
        context: f.context,
        workspaceId: f.workspaceId,
        assignmentId: f.assignmentId,
        employeeVersionId: f.employeeVersionId,
        sessionId: prior.sessionId,
        userMessageId,
        assistantMessageId,
        promptSnapshot: {
          ...prior.binding.promptSnapshot,
          userRequest: prompt,
        },
      });
      const submitted = await enqueueRun(
        f.context,
        {
          workspaceId: f.workspaceId,
          idempotencyKey: randomUUID(),
          type: 'allrice.employee.run',
          maxAttempts: 1,
          timeoutMs: binding.executionSnapshot.runtimePolicy.timeoutMs,
          input: {
            employeeAssignmentId: f.assignmentId,
            employeeVersionId: f.employeeVersionId,
            sessionId: prior.sessionId,
            userMessageId,
            assistantMessageId,
          },
        },
        { employeeBinding: binding },
      );
      const workerId = randomUUID();
      const job = await claimNextJob(workerId, 60000);
      const [expectedJob] =
        await f.db`select id from allrice_jobs where run_id=${submitted.run.id}`;
      expect(job!.id).toBe(expectedJob!.id);
      const workflowLease = {
        jobId: job!.id,
        workerId,
        leaseToken: job!.lease!.token,
        leaseMs: 60000,
      };
      const execution = await startClaimedJob(
        workerId,
        job!.id,
        workflowLease.leaseToken,
      );
      return {
        runId: submitted.run.id,
        sessionId: prior.sessionId,
        userMessageId,
        assistantMessageId,
        binding,
        execution: execution!,
        workflowLease,
      };
    }
    async function inducePause(task: Task) {
      const handle = port(task),
        nativeSessionId = `dsh-${task.sessionId}`;
      for (let i = 0; i < 3; i++) {
        await handle({
          action: 'start',
          kind: 'tool',
          nativeSessionId,
          callId: `failed-${i}`,
          name: 'read',
          argumentsDigest: `sha256:${'a'.repeat(64)}`,
        });
        await handle({
          action: 'finish',
          kind: 'tool',
          nativeSessionId,
          callId: `failed-${i}`,
          outcome: 'error',
          resultDigest: `sha256:${'b'.repeat(64)}`,
        });
      }
      return handle({ action: 'check', nativeSessionId });
    }
    function adapter(cordisConfig?: string) {
      const value = new DshHarnessAdapter({
        cordisConfig,
        runtimeRoot: join(model.root, 'runtime'),
        credentialResolver: {
          resolve: async () => ({ apiKey: 'synthetic-only' }),
        },
        requestTimeoutMs: 15000,
      });
      adapters.push(value);
      return value;
    }
    function execution(task: Task): HarnessExecutionInput {
      return {
        kernel: {
          schemaVersion: 1,
          harness: 'dsh',
          employeeAssignmentId: f.assignmentId,
          employeeVersionId: f.employeeVersionId,
          sessionId: task.sessionId,
          userMessageId: task.userMessageId,
          assistantMessageId: task.assistantMessageId,
          systemInstructions: 'Follow the user request.',
          userRequest: task.binding.promptSnapshot.userRequest,
          bootstrapConversation: '',
          authorizedMemoryContext: '',
          grantedCapabilities: [],
          skillVersionIds: [],
          imageAttachments: [],
        },
        providerSnapshot: {
          provider: 'dsh',
          route: 'openai-compatible',
          authMode: 'allrice_credential',
          model: 'native-progress',
          credentialReference: 'synthetic',
          baseUrl: model.baseUrl,
          reasoningEffort: 'none',
        },
        executionEnvironment: {
          ALLRICE_ORGANIZATION_ID: f.organizationId,
          ALLRICE_WORKSPACE_ID: f.workspaceId,
          ALLRICE_OWNER_ID: f.ownerId,
          ALLRICE_RUN_ID: task.runId,
          ALLRICE_JOB_ID: task.workflowLease.jobId,
        },
        tools: [
          {
            name: 'local.fs.list',
            description: 'List a directory',
            inputSchema: {},
          },
        ],
        storageObjects: [],
        workDirectory: model.root,
        signal: new AbortController().signal,
        attempt: 1,
        generation: 0,
        onEvent: async () => {},
        nativeQuestionWait: { mode: 'timed', seconds: 1 },
        progress: port(task),
      };
    }
    it.each([
      ['hot', 'continue'],
      ['cold', 'continue'],
      ['hot', 'cancel'],
      ['cold', 'cancel'],
      ['hot', 'pending'],
      ['cold', 'pending'],
    ] as const)(
      'preserves pause and accepted messages with a %s Host and %s decision',
      async (temperature, decision) => {
        const first = await setup();
        model = await p24Fixture(async (_request, index) =>
          index <= 3
            ? { nativeTool: { name: 'local_fs_list', arguments: { path: 42 } } }
            : { text: '已按这条新消息继续。' },
        );
        let host = adapter();
        const result = await host.execute(execution(first));
        expect(result.waitingForUser?.questionId).toBeTruthy();
        expect(model.requests).toHaveLength(3);
        const [oldPause] =
          await f.db`select * from allrice_task_progress where run_id=${first.runId}`;
        expect(oldPause).toMatchObject({
          pause_id: expect.any(String),
          canceled: false,
        });
        await completeJob({ ...first.workflowLease, result });
        expect(host.runtimeInventory()).toHaveLength(0);
        if (temperature === 'cold') {
          await host.close();
          host = adapter();
        }
        const prompt = '先保留这条新消息，确认以后按它继续处理。';
        const next = await followUp(first, prompt);
        const input = execution(next);
        let turnId = '';
        input.onTurnStarted = async (turn) => {
          turnId = turn.turnId;
        };
        const cards: unknown[] = [];
        input.onEvent = async (event) => {
          if (event.sourceEventType !== 'session/user-question') return;
          cards.push(event.sourcePayload);
          expect(model.requests).toHaveLength(3);
          const [moved] =
            await f.db`select pause_id from allrice_task_progress where run_id=${next.runId}`;
          expect(moved!.pause_id).toBe(oldPause!.pause_id);
          if (decision === 'pending') return;
          const pool = Reflect.get(host, 'runtimePool') as DshRuntimePool;
          const session = `dsh-${next.sessionId}`;
          await pool
            .get(session)!
            .client.steer(
              session,
              `allrice:user-question:v1:${JSON.stringify({ questionId: (event.sourcePayload as { questionId: string }).questionId, answers: [{ id: 'runtime-progress', selected: [decision === 'continue' ? '重新检查后继续' : '取消任务'] }] })}`,
              {
                inputId: randomUUID(),
                turnId,
                kind: 'ask_user',
                runId: next.runId,
              },
            );
        };
        const work = host.execute(input);
        if (decision === 'cancel') await expect(work).rejects.toThrow();
        else {
          const resumed = await work;
          expect(Boolean(resumed.waitingForUser)).toBe(decision === 'pending');
          await completeJob({ ...next.workflowLease, result: resumed });
          expect(host.runtimeInventory()).toHaveLength(
            decision === 'pending' ? 0 : 1,
          );
        }
        expect(cards).toHaveLength(1);
        const rows =
          await f.db`select run_id,pause_id,canceled,state from allrice_task_progress where run_id in (${first.runId},${next.runId})`;
        expect(rows.find((row) => row.run_id === first.runId)).toMatchObject({
          pause_id: null,
          state: oldPause!.state,
        });
        expect(rows.find((row) => row.run_id === next.runId)).toMatchObject({
          pause_id: decision === 'continue' ? null : oldPause!.pause_id,
          canceled: decision === 'cancel',
        });
        const decisions =
          await f.db`select run_id,pause_id,decision from allrice_task_progress_decisions where run_id in (${first.runId},${next.runId})`;
        expect([...decisions]).toEqual(
          decision === 'pending'
            ? []
            : [{ run_id: next.runId, pause_id: oldPause!.pause_id, decision }],
        );
        expect(model.requests).toHaveLength(decision === 'continue' ? 4 : 3);
        if (decision === 'continue')
          expect(JSON.stringify(model.requests.at(-1)!.messages)).toContain(
            prompt,
          );
        // Read the persisted native journal after success, cancellation or cold restart.
        const { readdir, readFile } = await import('node:fs/promises');
        const files = await readdir(join(model.root, 'runtime'), {
          recursive: true,
        });
        const journals = await Promise.all(
          files
            .filter((file) => file.endsWith('.jsonl'))
            .map((file) => readFile(join(model.root, 'runtime', file), 'utf8')),
        );
        expect(journals.join('\n')).toContain(prompt);
      },
      30000,
    );

    it.each(['continue', 'cancel', 'pending', 'stop'] as const)(
      'real adapter handles an idle root and paused native child: %s',
      async (decision) => {
        const task = await setup();
        let releaseRoot!: () => void;
        const rootIdle = new Promise<void>((resolveIdle) => {
          releaseRoot = resolveIdle;
        });
        let rootRequests = 0,
          childRequests = 0;
        model = await p24Fixture(async (request) => {
          const child = JSON.stringify(
            request.messages.find((m) => m.role === 'user')?.content,
          ).includes('CHILD_ONLY');
          if (!child)
            return ++rootRequests === 1
              ? {
                  nativeTool: {
                    name: 'subagent',
                    arguments: {
                      description: '读取目录',
                      prompt: 'CHILD_ONLY 读取目录，失败时请主员工问我',
                    },
                  },
                }
              : { text: '子任务结束后汇总。' };
          await rootIdle;
          return ++childRequests <= 3
            ? { nativeTool: { name: 'local_fs_list', arguments: { path: 42 } } }
            : { text: '子任务完成。' };
        });
        // Only tests append the same-generation public delegation composition.
        // The production profiles remain unchanged and delegation stays OFF.
        const profile = join(model.root, 'native-test.yml');
        await symlink(
          resolve(import.meta.dirname, '../../node_modules'),
          join(model.root, 'node_modules'),
        );
        await writeFile(
          profile,
          (await readFile(
            resolve(
              import.meta.dirname,
              '../../dsh/allrice-restricted.cordis.yml',
            ),
            'utf8',
          )) +
            '\n' +
            (await readFile(
              resolve(
                import.meta.dirname,
                '../native-subagent/plugins.cordis.yml',
              ),
              'utf8',
            )),
        );
        const host = adapter(profile),
          input = execution(task);
        const owned = {
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          sessionId: task.sessionId,
          runId: task.runId,
          workerId: task.workflowLease.workerId,
        };
        await acquireConversationRuntime({
          ...owned,
          ownerId: f.ownerId,
          configChecksum: `sha256:${'a'.repeat(64)}`,
          compactThresholdTokens: 10000,
        });
        const bound = await bindConversationThread({
          ...owned,
          threadId: `dsh-${task.sessionId}`,
        });
        browserAuth.context.mockResolvedValue(f.context);
        const controller = new AbortController();
        input.signal = controller.signal;
        const progress = port(task);
        input.nativeRunAuthority = () => () =>
          progress({
            action: 'check',
            nativeSessionId: `dsh-${task.sessionId}`,
          });
        const facts: Record<string, unknown>[] = [];
        input.nativeAccounting = {
          bind: () => ({
            record: async (fact) => {
              facts.push(fact);
            },
            delivered: () => {},
          }),
        };
        let turnId = '',
          idle = false,
          cards = 0,
          unsubscribe: (() => void) | undefined;
        input.onTurnStarted = async (turn) => {
          turnId = turn.turnId;
          await recordConversationTurn({
            ...owned,
            threadId: `dsh-${task.sessionId}`,
            turnId,
          });
        };
        input.onEvent = async (event) => {
          if (!unsubscribe) {
            const pool = Reflect.get(host, 'runtimePool') as DshRuntimePool;
            const runtime = pool.get(`dsh-${task.sessionId}`);
            if (runtime)
              unsubscribe = runtime.client.subscribe((n) => {
                if (
                  n.params.sessionId === runtime.sessionId &&
                  n.method === 'session.status'
                ) {
                  idle = n.params.status === 'idle';
                  if (idle) releaseRoot();
                }
              });
          }
          if (event.sourceEventType !== 'session/user-question') return;
          cards++;
          expect(idle).toBe(true);
          expect(childRequests).toBe(3);
          if (decision === 'pending') return;
          if (decision === 'stop') {
            controller.abort();
            return;
          }
          const q = event.sourcePayload as {
            questionId: string;
            progress: { runId: string; pauseId: string };
          };
          expect(q.progress).toMatchObject({
            runId: task.runId,
            pauseId: expect.any(String),
          });
          const response = await POST(
            new Request(
              `http://localhost/api/v1/sessions/${task.sessionId}/messages?workspaceId=${f.workspaceId}`,
              {
                method: 'POST',
                headers: {
                  origin: 'http://localhost',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  text: '回答进度题',
                  clientMessageId: randomUUID(),
                  deliveryMode: 'steer',
                  expectedTurnId: turnId,
                  expectedGeneration: bound.generation,
                  userQuestionAnswer: {
                    questionId: q.questionId,
                    answers: [
                      {
                        id: 'runtime-progress',
                        selected: [
                          decision === 'continue'
                            ? '重新检查后继续'
                            : '取消任务',
                        ],
                      },
                    ],
                  },
                }),
              },
            ),
            { params: Promise.resolve({ id: task.sessionId }) },
          );
          expect(response.status, await response.text()).toBe(202);
          const command = await claimConversationSteer({
            ...owned,
            generation: bound.generation,
            turnId,
          });
          expect(command?.inputKind).toBe('ask_user');
          const proof = await host.steer({
            threadId: `dsh-${task.sessionId}`,
            runId: task.runId,
            turnId: command!.turnId,
            clientUserMessageId: command!.clientUserMessageId,
            inputKind: 'ask_user',
            message: command!.message,
          });
          expect(proof).toMatchObject({ status: 'adopted', runId: task.runId });
          if (!proof) throw Error('missing proof');
          await consumeConversationSteer({
            commandId: command!.id,
            workerId: owned.workerId,
            proof,
          });
          expect(
            await f.db`select state from allrice_conversation_commands where id=${command!.id}`,
          ).toEqual([{ state: 'consumed' }]);
          expect(
            await f.db`select state from allrice_conversation_followups where run_id=${command!.followupRunId}`,
          ).toEqual([{ state: 'consumed' }]);
        };
        try {
          const work = host.execute(input);
          if (decision === 'cancel' || decision === 'stop')
            await expect(work).rejects.toThrow();
          else {
            const result = await work;
            expect(Boolean(result.waitingForUser)).toBe(decision === 'pending');
            const [pause] =
              await f.db`select pause_id, canceled from allrice_task_progress where run_id=${task.runId}`;
            if (decision === 'pending') {
              expect(result.waitingForUser?.pauseId).toBe(pause!.pause_id);
              expect(pause!.canceled).toBe(false);
              expect(host.runtimeInventory()).toHaveLength(0);
            }
          }
          expect(cards).toBe(1);
          const childFinishes = facts.filter(
            (v) =>
              v.phase === 'finish' &&
              v.nativeSessionId !== `dsh-${task.sessionId}`,
          );
          expect(childFinishes).toHaveLength(4);
          if (decision !== 'continue')
            expect(childFinishes.at(-1)).toMatchObject({
              outcome: 'incomplete',
              usage: {},
              usageComplete: false,
            });
          expect(new Set(facts.map((v) => v.nativeSessionId)).size).toBe(2);
          const [lease] =
            await f.db`select worker_id, lease_token from allrice_jobs where id=${task.workflowLease.jobId}`;
          expect(lease).toMatchObject({
            worker_id: task.workflowLease.workerId,
            lease_token: task.workflowLease.leaseToken,
          });
        } finally {
          releaseRoot();
          unsubscribe?.();
        }
      },
      30000,
    );
    it.each([
      'continued',
      'canceled',
      'different-session',
      'different-workspace',
      'different-org',
      'already-initialized',
      'stopped',
      'failed',
      'timed-out',
      'previous-running',
      'previous-leased',
    ] as const)(
      'does not transfer a pause for %s',
      async (variant) => {
        const first = await setup();
        const pause = await inducePause(first);
        const nativeSessionId = `dsh-${first.sessionId}`;
        if (variant === 'continued' || variant === 'canceled')
          await port(first)({
            action: 'decide',
            nativeSessionId,
            pauseId: pause.pauseId,
            decision: variant === 'continued' ? 'continue' : 'cancel',
          });
        if (variant === 'stopped')
          await f.db.begin((tx) =>
            requestRunCancellationTransaction(
              tx,
              f.context,
              first.runId,
              'user_stop',
            ),
          );
        if (['stopped', 'failed', 'timed-out'].includes(variant)) {
          await failJob({
            ...first.workflowLease,
            code:
              variant === 'timed-out' ? 'TASK_TIMEOUT' : 'SYNTHETIC_FAILURE',
            message: variant,
            retryable: false,
          });
        } else if (variant === 'previous-leased') {
          // Prove a terminal-looking Run is still excluded when its job owns a lease.
          await f.db`update allrice_runs set state='succeeded' where id=${first.runId}`;
        } else if (variant !== 'previous-running') {
          await completeJob({
            ...first.workflowLease,
            result: { waitingForUser: { questionId: 'expired-card' } },
          });
        }
        if (variant === 'different-org' || variant === 'different-workspace') {
          // Valid current lease in another scope, deliberately bound to the old
          // session ID: only the transfer query's tenant predicates can reject it.
          const organizationId =
            variant === 'different-org' ? randomUUID() : f.organizationId;
          const workspaceId = randomUUID(),
            runId = randomUUID(),
            jobId = randomUUID();
          const workerId = randomUUID(),
            leaseToken = randomUUID();
          if (variant === 'different-org')
            await f.db`insert into allrice_organizations(id,slug,name) values(${organizationId},${organizationId},'Other org')`;
          await f.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${organizationId},${workspaceId},'Other workspace')`;
          await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
            values(${runId},${organizationId},${workspaceId},${f.ownerId},'running','{}','{}')`;
          await f.db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
            values(${jobId},${organizationId},${workspaceId},${f.ownerId},${runId},'running',${runId},clock_timestamp()+interval '10 minutes','{}',${workerId},${leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes')`;
          await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
            select ${runId},${organizationId},${workspaceId},policy from allrice_task_clocks where run_id=${first.runId}`;
          const handle = createTaskProgressRuntime(
            {
              context: {
                ...first.execution.context,
                runId,
                organizationId,
                workspaceId,
              },
              worker: { jobId, workerId, leaseToken },
              sessionId: first.sessionId,
            },
            f.db,
          );
          expect(
            await handle({ action: 'check', nativeSessionId }),
          ).toMatchObject({ paused: false, pauseId: null });
          const [created] =
            await f.db`select pause_id from allrice_task_progress where run_id=${runId}`;
          expect(created).toMatchObject({ pause_id: null });
          const [old] =
            await f.db`select pause_id from allrice_task_progress where run_id=${first.runId}`;
          expect(old!.pause_id).toBe(pause.pauseId);
          return;
        }
        let previous = first;
        if (variant === 'different-session') {
          const otherSession = randomUUID();
          await f.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${otherSession},${f.organizationId},${f.workspaceId},${f.ownerId},'Other session',${f.assignmentId},${f.employeeVersionId})`;
          previous = { ...first, sessionId: otherSession };
        }
        const next = await followUp(previous, '下一轮先等我确认。');
        if (variant === 'already-initialized')
          await createTaskProgressRuntime(
            { context: next.execution.context, worker: next.workflowLease },
            f.db,
          )({ action: 'check', nativeSessionId });
        const handle = port(next);
        expect(
          await handle({ action: 'check', nativeSessionId }),
        ).toMatchObject({ paused: false, pauseId: null });
        const old =
          await f.db`select pause_id from allrice_task_progress where run_id=${first.runId}`;
        expect(old[0]!.pause_id).toBe(
          variant === 'continued' ? null : pause.pauseId,
        );
      },
      30000,
    );
  },
);
