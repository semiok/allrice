/** Real queue/progress ledger + production adapter and native Host; loopback model.
 * Worker finalization is separately exercised in subscription-worker.integration. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  claimNextJob,
  completeJob,
  enqueueRun,
  startClaimedJob,
} from '../../../../packages/database/src/execution/queue.ts';
import { prepareEmployeeRunBinding } from '../../../../packages/database/src/employees/employeehub.ts';
import { createTaskProgressRuntime } from '../../../../packages/database/src/task-progress.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import type { HarnessExecutionInput } from '../../src/harness/adapter.ts';
import type { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.ts';
import { p24Fixture } from '../p24/fixture.ts';

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
      f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
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
    function adapter() {
      const value = new DshHarnessAdapter({
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
        const originalHostId = host.runtimeInventory()[0]!.id;
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
              { inputId: randomUUID(), turnId, kind: 'ask_user' },
            );
        };
        const work = host.execute(input);
        if (decision === 'cancel') await expect(work).rejects.toThrow();
        else {
          const resumed = await work;
          expect(Boolean(resumed.waitingForUser)).toBe(decision === 'pending');
          await completeJob({ ...next.workflowLease, result: resumed });
          expect(host.runtimeInventory()[0]!.id === originalHostId).toBe(
            temperature === 'hot',
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

    it.each([
      'continued',
      'canceled',
      'different-session',
      'different-workspace',
      'different-org',
      'already-initialized',
      'legacy-assistants',
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
        await completeJob({ ...first.workflowLease, result: {} });
        let previous = first;
        if (variant === 'different-session') {
          const otherSession = randomUUID();
          await f.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${otherSession},${f.organizationId},${f.workspaceId},${f.ownerId},'Other session',${f.assignmentId},${f.employeeVersionId})`;
          previous = { ...first, sessionId: otherSession };
        }
        const next = await followUp(previous, '下一轮先等我确认。');
        if (variant === 'different-org' || variant === 'different-workspace') {
          const handle = createTaskProgressRuntime(
            {
              context: {
                ...next.execution.context,
                ...(variant === 'different-org'
                  ? { organizationId: randomUUID() }
                  : { workspaceId: randomUUID() }),
              },
              worker: next.workflowLease,
              sessionId: first.sessionId,
            },
            f.db,
          );
          await expect(
            handle({ action: 'check', nativeSessionId }),
          ).rejects.toThrow('task_progress_lease_lost');
          const old =
            await f.db`select pause_id from allrice_task_progress where run_id=${first.runId}`;
          expect(old[0]!.pause_id).toBe(pause.pauseId);
          return;
        }
        if (variant === 'already-initialized')
          await createTaskProgressRuntime(
            { context: next.execution.context, worker: next.workflowLease },
            f.db,
          )({ action: 'check', nativeSessionId });
        const handle =
          variant === 'legacy-assistants'
            ? createTaskProgressRuntime(
                { context: next.execution.context, worker: next.workflowLease },
                f.db,
              )
            : port(next);
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
