/** Real Worker, queue, Workflow Engine and PG. Only native execution and the
 * maintenance repository service are synthetic; no provider credentials. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { authorizeFixturePlatformAdministrator } from '../../../../packages/database/src/platform-authority.fixture.ts';
import {
  createWorkflow,
  manageEmployeeCapabilities,
} from '../../../../packages/database/src/capabilities/capability-registry.ts';
import {
  claimNextJob,
  completeJob,
  enqueueRun,
  startClaimedJob,
} from '../../../../packages/database/src/execution/queue.ts';
import { prepareEmployeeRunBinding } from '../../../../packages/database/src/employees/employeehub.ts';
import { updateUserPreferences } from '../../../../packages/database/src/user-preferences.ts';
import type * as Database from '@allrice/database';
import type * as PlatformRepair from '../../src/jobs/platform-repair.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.ts';
import { executeEmployeeRun } from '../../src/jobs/employee-run.ts';
import { prepareExecutionIsolation } from '../../src/isolation.ts';
// @ts-expect-error Native Host modules are JavaScript and run unchanged in this test.
import { installTaskProgress } from '../../dsh/allrice-task-progress.mjs';

const state = vi.hoisted(() => ({ maintenance: false }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getCodexProviderStatus: vi.fn(async () => ({ status: 'connected' })),
  getPlatformRepairExecution: vi.fn(async () => {
    if (!state.maintenance) throw Error('TEST_UNEXPECTED_REPAIR');
    return {
      frozen: {
        version: 2,
        fingerprint: `sha256:${'a'.repeat(64)}`,
        maintenance: { maxOutputTokens: 16000 },
      },
    };
  }),
}));
vi.mock('../../src/jobs/platform-repair.js', async (original) => ({
  ...(await original<typeof PlatformRepair>()),
  createPlatformRepairController: vi.fn(async () => ({
    onToolCall: () => {
      throw Error('TEST_REPAIR_TOOL_FORBIDDEN');
    },
    finish: () => {
      throw Error('TEST_REPAIR_FINISH_FORBIDDEN');
    },
  })),
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET-210 real Worker continuation and Workflow waiting', () => {
  let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
  let root: string;
  afterEach(async () => {
    vi.restoreAllMocks();
    await f?.close();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    state.maintenance = false;
  });
  async function setup() {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.spyOn(DshRuntimePool.prototype, 'acquire').mockRejectedValue(
      Error('TEST_NATIVE_ACQUISITION_FORBIDDEN'),
    );
    vi.spyOn(DshHarnessAdapter.prototype, 'isConfigured').mockReturnValue(true);
    root = await realpath(
      await mkdtemp(join(tmpdir(), 'timed-progress-worker-')),
    );
    vi.stubEnv('ALLRICE_STORAGE_ROOT', join(root, 'storage'));
    f = await createP27CodexWorkerFixture({
      allowCiDatabase: true,
      personalProfile: 'writable',
    });
    await updateUserPreferences(f.context, {
      questionWait: { mode: 'timed', seconds: 7 },
    });
    return f.prepareOrdinaryTask('读取目录；如果连续失败，等我确认后再继续。');
  }
  type Task = Awaited<ReturnType<typeof setup>>;
  async function followUp(
    prior: Task,
    prompt: string,
    extra: Record<string, unknown> = {},
  ) {
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
          ...extra,
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
  async function run(task: Task) {
    const isolation = await prepareExecutionIsolation({
      root,
      organizationId: f.organizationId,
      workspaceId: f.workspaceId,
      ownerId: f.ownerId,
      runId: task.runId,
      jobId: task.workflowLease.jobId,
      attempt: task.execution.job.attempt,
    });
    try {
      return await executeEmployeeRun({
        execution: task.execution,
        isolation,
        signal: new AbortController().signal,
        onHarnessEvent: async () => {},
        workflowLease: task.workflowLease,
      });
    } finally {
      await isolation.cleanup();
    }
  }
  async function collect(stream: AsyncIterable<unknown>) {
    const result = [];
    for await (const item of stream) result.push(item);
    return result;
  }
  function result(task: Task, waiting = true) {
    return {
      answer: 'Synthetic',
      threadId: `dsh-${task.sessionId}`,
      provider: 'openai-codex',
      model: task.binding.executionSnapshot.modelSnapshot!.model,
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
      usageComplete: true,
      cacheUsageKnown: true,
      ...(waiting ? { waitingForUser: { questionId: 'progress-card' } } : {}),
    };
  }
  async function firstWait() {
    const first = await setup();
    const execute = vi
      .spyOn(DshHarnessAdapter.prototype, 'execute')
      .mockImplementation(async (input) => {
        expect(input.nativeQuestionWait).toEqual({ mode: 'timed', seconds: 7 });
        // Induce the pause through the exact production port given to the adapter.
        for (let i = 0; i < 3; i++) {
          await input.progress!({
            action: 'start',
            kind: 'tool',
            nativeSessionId: `dsh-${first.sessionId}`,
            callId: `failed-${i}`,
            name: 'read',
            argumentsDigest: `sha256:${'a'.repeat(64)}`,
          });
          await input.progress!({
            action: 'finish',
            kind: 'tool',
            nativeSessionId: `dsh-${first.sessionId}`,
            callId: `failed-${i}`,
            outcome: 'error',
            resultDigest: `sha256:${'b'.repeat(64)}`,
          });
        }
        return result(first);
      });
    const waiting = await run(first);
    expect(waiting).toHaveProperty('waitingForUser', {
      questionId: 'progress-card',
    });
    await completeJob({ ...first.workflowLease, result: waiting });
    const [pause] =
      await f.db`select pause_id from allrice_task_progress where run_id=${first.runId}`;
    expect(pause!.pause_id).toEqual(expect.any(String));
    return { first, execute, pauseId: pause!.pause_id };
  }
  it.each(['ordinary', 'compaction', 'maintenance'] as const)(
    'second Run only inherits in the ordinary Worker path: %s',
    async (mode) => {
      const { first, execute, pauseId } = await firstWait();
      const ordinary = mode === 'ordinary' || mode === 'compaction';
      state.maintenance = mode === 'maintenance';
      const next = await followUp(first, '下一轮确认后继续。');
      // This test supplies the maintenance service's envelope after real queue
      // admission; repository authorization itself has separate integration tests.
      if (state.maintenance)
        next.execution.payload.input = {
          ...(next.execution.payload.input as Record<string, unknown>),
          repairRequestId: randomUUID(),
        };
      execute.mockImplementation(async (input) => {
        if (state.maintenance)
          expect(
            input.executionEnvironment.ALLRICE_MAINTENANCE_OUTPUT_TOKENS,
          ).toBe('16000');
        expect(
          await input.progress!({
            action: 'check',
            nativeSessionId: `dsh-${first.sessionId}`,
          }),
        ).toMatchObject(
          ordinary
            ? { paused: true, pauseId }
            : { paused: false, pauseId: null },
        );
        if (mode === 'compaction') {
          const hooks = new Map();
          const agent = { id: `dsh-${first.sessionId}` };
          const ask = vi.fn(async () => ({
            answers: [{ id: 'runtime-progress', selected: ['重新检查后继续'] }],
          }));
          installTaskProgress(
            {
              on: (name: string, fn: unknown) => hooks.set(name, fn),
              agents: { get: () => agent, roots: () => [agent] },
              userQuestions: { ask, askTimed: ask },
            },
            input.progress!,
          );
          const stream = vi.fn(async function* () {
            yield { type: 'text', text: 'done' };
          });
          await expect(
            collect(
              hooks.get('llm/stream')(
                { sessionId: agent.id, purpose: 'compaction' },
                stream,
              ),
            ),
          ).rejects.toThrow('task_progress_paused');
          expect(ask).not.toHaveBeenCalled();
          await collect(
            hooks.get('llm/stream')({ sessionId: agent.id }, stream),
          );
          expect(ask).toHaveBeenCalledOnce();
          expect(stream).toHaveBeenCalledOnce();
          return result(next, false);
        }
        if (ordinary) {
          await input.progress!({
            action: 'decide',
            nativeSessionId: `dsh-${first.sessionId}`,
            pauseId,
            decision: 'continue',
          });
          return result(next, false);
        }
        throw Error('TEST_PROGRESS_CHECKED');
      });
      if (ordinary) {
        const completed = await run(next);
        expect(completed).not.toHaveProperty('waitingForUser');
        await completeJob({ ...next.workflowLease, result: completed });
        const [saved] =
          await f.db`select state from allrice_runs where id=${next.runId}`;
        expect(saved!.state).toBe('succeeded');
      } else expect(execute).toHaveBeenCalledTimes(2);
      const [prior] =
        await f.db`select pause_id from allrice_task_progress where run_id=${first.runId}`;
      expect(prior!.pause_id).toBe(ordinary ? null : pauseId);
    },
    30000,
  );
  it.each(['model', 'agent_skill'] as const)(
    'a Workflow %s step keeps blocking like main, then completes without an orphaned running instance',
    async (kind) => {
      const { first, execute, pauseId } = await firstWait();
      await authorizeFixturePlatformAdministrator(f.db, f.ownerId);
      const workflow = await createWorkflow(f.context, {
        workspaceId: f.workspaceId,
        slug: `progress-${randomUUID()}`,
        name: '确认后执行',
        description: '确认后继续处理我的请求',
        definition: {
          schemaVersion: 1,
          steps: [
            { key: 'ask', name: '先确认', kind },
            {
              key: 'after',
              name: '确认后的步骤',
              kind: 'model',
              dependsOn: ['ask'],
            },
          ],
        },
      });
      await manageEmployeeCapabilities(f.context, {
        workspaceId: f.workspaceId,
        employeeId: f.employeeId,
        agentSkills: [],
        knowledgeRevisionIds: [],
        workflowRevisionIds: [workflow.id],
      });
      const next = await followUp(
        first,
        '按流程执行工作流「确认后执行」，先等我确认。',
      );
      // Change the live preference after admission: Workflow must retain 7 s.
      await updateUserPreferences(f.context, {
        questionWait: { mode: 'timed', seconds: 19 },
      });
      let answer!: (value: {
        answers: { id: string; selected: string[] }[];
      }) => void;
      let presented!: () => void;
      const asked = new Promise<void>((resolve) => {
        presented = resolve;
      });
      const ask = vi.fn(
        () =>
          new Promise((resolve) => {
            answer = resolve;
            presented();
          }),
      );
      const askTimed = vi.fn(() => {
        throw Error('TEST_WORKFLOW_TIMED_ASK_FORBIDDEN');
      });
      const model = vi.fn(async function* () {
        yield { type: 'text', text: 'done' };
      });
      execute.mockImplementation(async (input) => {
        expect(input.nativeQuestionWait).toEqual({ mode: 'timed', seconds: 7 });
        expect(input.executionEnvironment.ALLRICE_QUESTION_RELEASE_MS).toBe(
          '0',
        );
        if (input.kernel.systemInstructions.includes('workflow step after'))
          return result(next, false);
        expect(input.kernel.systemInstructions).toContain('workflow step ask');
        const nativeSessionId = `dsh-${first.sessionId}`;
        expect(
          await input.progress!({ action: 'check', nativeSessionId }),
        ).toMatchObject({ paused: false, pauseId: null });
        // This Workflow keeps its own blocking pause; it never inherits the
        // earlier ordinary Run's expired question.
        for (let i = 0; i < 3; i++) {
          await input.progress!({
            action: 'start',
            kind: 'tool',
            nativeSessionId,
            callId: `workflow-failure-${i}`,
            name: 'read',
            argumentsDigest: `sha256:${'a'.repeat(64)}`,
          });
          await input.progress!({
            action: 'finish',
            kind: 'tool',
            nativeSessionId,
            callId: `workflow-failure-${i}`,
            outcome: 'error',
            resultDigest: `sha256:${'b'.repeat(64)}`,
          });
        }
        const hooks = new Map();
        const agent = { id: nativeSessionId };
        vi.stubEnv(
          'ALLRICE_QUESTION_RELEASE_MS',
          input.executionEnvironment.ALLRICE_QUESTION_RELEASE_MS,
        );
        vi.stubEnv('ALLRICE_ASK_USER_TIMEOUT', '7');
        installTaskProgress(
          {
            on: (name: string, fn: unknown) => hooks.set(name, fn),
            agents: { get: () => agent, roots: () => [agent] },
            userQuestions: { ask, askTimed },
          },
          input.progress!,
        );
        await collect(
          hooks.get('llm/stream')({ sessionId: nativeSessionId }, model),
        );
        await input.onThreadBound?.({
          threadId: `dsh-${next.sessionId}`,
          resumed: false,
          replacedThreadId: null,
        });
        return result(next, false);
      });
      let settled = false;
      const running = run(next);
      void running.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.race([
        asked,
        running.then(() => {
          throw Error('TEST_WORKFLOW_ENDED_BEFORE_ANSWER');
        }),
      ]);
      try {
        expect(settled).toBe(false);
        expect(ask).toHaveBeenCalledOnce();
        expect(askTimed).not.toHaveBeenCalled();
        expect(model).not.toHaveBeenCalled();
        const [active] =
          await f.db`select r.state,j.lease_token,w.status as workflow_status
          from allrice_runs r join allrice_jobs j on j.run_id=r.id
          join allrice_workflow_runs w on w.run_id=r.id where r.id=${next.runId}`;
        expect(active).toMatchObject({
          state: 'running',
          lease_token: next.workflowLease.leaseToken,
          workflow_status: 'running',
        });
        const pending =
          await f.db`select s.step_key,s.status from allrice_workflow_step_runs s
          join allrice_workflow_runs w on w.id=s.workflow_run_id where w.run_id=${next.runId} order by s.step_key`;
        expect(pending).toMatchObject([
          { step_key: 'after', status: 'pending' },
          { step_key: 'ask', status: 'running' },
        ]);
      } finally {
        answer({
          answers: [{ id: 'runtime-progress', selected: ['重新检查后继续'] }],
        });
      }
      const completed = await running;
      expect(completed).not.toHaveProperty('waitingForUser');
      await completeJob({ ...next.workflowLease, result: completed });
      expect(execute).toHaveBeenCalledTimes(3);
      expect(model).toHaveBeenCalledOnce();
      const rows =
        await f.db`select s.step_key,s.status,s.output from allrice_workflow_step_runs s
        join allrice_workflow_runs w on w.id=s.workflow_run_id where w.run_id=${next.runId} order by s.step_key`;
      expect(rows).toMatchObject([
        { step_key: 'after', status: 'succeeded' },
        { step_key: 'ask', status: 'succeeded' },
      ]);
      expect(rows.every((row) => row.output !== null)).toBe(true);
      const [saved] =
        await f.db`select r.state,j.lease_token,w.status as workflow_status,p.pause_id from allrice_runs r
        join allrice_jobs j on j.run_id=r.id join allrice_workflow_runs w on w.run_id=r.id
        join allrice_task_progress p on p.run_id=r.id where r.id=${next.runId}`;
      expect(saved).toMatchObject({
        state: 'succeeded',
        lease_token: null,
        workflow_status: 'succeeded',
        pause_id: null,
      });
      const [prior] =
        await f.db`select pause_id from allrice_task_progress where run_id=${first.runId}`;
      expect(prior!.pause_id).toBe(pauseId);
    },
    30000,
  );
});
