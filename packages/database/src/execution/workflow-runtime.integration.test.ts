/** Opt-in isolated PostgreSQL only. Synthetic queue/Workflow fixtures, no
 * provider, native Host, Worker process, real account or source SQL mock. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ExecutionContextSchema,
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from '../assistant-runtime.fixture.ts';
import { heartbeatJob } from './queue.ts';
import {
  completeWorkflowStep,
  ensureWorkflowRunForExecution,
  failWorkflowStep,
  getWorkflowExecution,
  startWorkflowStep,
  workflowDigest,
} from './workflow-runtime.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'Workflow job-incarnation recovery and heartbeat — isolated PostgreSQL',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
    }, 120_000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await database?.close();
    }, 30_000);

    async function setup(
      options: {
        sideEffect?: 'none' | 'idempotent' | 'non_idempotent';
        recoveryPolicy?: WorkflowDefinition['recoveryPolicy'];
      } = {},
    ) {
      const f = await assistantFixture(database.db);
      const org = f.context.organizationId,
        workspace = f.context.workspaceId!;
      const user = f.context.actor.id,
        policyId = randomUUID();
      const [policy] = await database.db<
        { issued_at: Date; expires_at: Date }[]
      >`
      insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at)
      values(${policyId},${org},${user},1,'{"memberships":[],"grants":[]}',clock_timestamp()+interval '1 hour')
      returning issued_at,expires_at`;
      await database.db`update allrice_runs set policy_snapshot_id=${policyId} where id=${f.task.runId}`;
      const execution = ExecutionContextSchema.parse({
        executionId: randomUUID(),
        runId: f.task.runId,
        jobId: f.worker.jobId,
        worker: { type: 'worker', id: f.worker.workerId },
        delegatedBy: { type: 'user', id: user },
        organizationId: org,
        workspaceId: workspace,
        policySnapshot: {
          id: policyId,
          organizationId: org,
          subjectId: user,
          version: 1,
          issuedAt: policy!.issued_at.toISOString(),
          expiresAt: policy!.expires_at.toISOString(),
          memberships: [],
          grants: [],
        },
        startedAt: new Date().toISOString(),
      });
      const [employee] = await database.db<{ employee_id: string }[]>`
      select employee_id from allrice_employee_assignments where id=(
        select employee_assignment_id from allrice_chat_sessions where id=${f.task.chatSessionId})`;
      const definition = WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        recoveryPolicy: options.recoveryPolicy ?? 'checkpoint',
        steps: [
          {
            key: 'load',
            name: 'Read fixed input',
            kind: 'tool',
            input: { action: 'load' },
          },
          {
            key: 'save',
            name: 'Commit fixed result',
            kind: 'tool',
            dependsOn: ['load'],
            input: { action: 'save' },
            sideEffect: options.sideEffect ?? 'idempotent',
            ...(options.sideEffect === 'non_idempotent'
              ? { compensation: { mode: 'manual' } }
              : {}),
          },
        ],
      });
      const workflowId = randomUUID(),
        revisionId = randomUUID();
      await database.db`insert into allrice_workflows(id,organization_id,workspace_id,slug,name,description,created_by)
      values(${workflowId},${org},${workspace},${`recovery-${workflowId}`},'Recovery fixture','Synthetic only',${user})`;
      await database.db`insert into allrice_workflow_revisions(id,organization_id,workspace_id,workflow_id,revision,name,description,definition,checksum,created_by,published_at)
      values(${revisionId},${org},${workspace},${workflowId},1,'Recovery fixture','Synthetic only',${database.db.json(JSON.parse(JSON.stringify(definition)))},${workflowDigest(definition)},${user},clock_timestamp())`;
      await database.db`insert into allrice_employee_workflow_bindings(organization_id,workspace_id,employee_id,workflow_revision_id,bound_by)
      values(${org},${workspace},${employee!.employee_id},${revisionId},${user})`;
      const workflowInput = { exact: 'immutable fixture input' };
      await ensureWorkflowRunForExecution({
        context: execution,
        ownerId: user,
        employeeId: employee!.employee_id,
        workflowRevisionId: revisionId,
        sessionId: f.task.chatSessionId,
        value: workflowInput,
      });
      const snapshot = () =>
        getWorkflowExecution({
          organizationId: org,
          workspaceId: workspace,
          runId: f.task.runId,
        });
      const value = (key: 'load' | 'save') => ({
        workflowInput,
        configured: definition.steps.find((s) => s.key === key)!.input,
        dependencies: key === 'save' ? { load: { facts: ['fixed'] } } : {},
      });
      const start = (
        key: 'load' | 'save',
        context = execution,
        token = f.worker.leaseToken,
        input = value(key),
      ) =>
        startWorkflowStep({
          context,
          workerId: context.worker.id,
          jobId: context.jobId,
          leaseToken: token,
          stepKey: key,
          value: input,
          leaseMs: 30_000,
        });
      const loaded = async () => {
        const first = await start('load');
        await completeWorkflowStep({
          context: execution,
          stepId: first.step.id,
          leaseToken: f.worker.leaseToken,
          output: { facts: ['fixed'] },
        });
      };
      const takeover = async () => {
        const token = randomUUID(),
          workerId = randomUUID();
        // State written by a successful queue claim/start after a crashed owner.
        // All runtime SQL thereafter is the real current job-token gate.
        await database.db`update allrice_jobs set attempt=attempt+1,worker_id=${workerId},lease_token=${token},
        lease_expires_at=clock_timestamp()+interval '10 minutes' where id=${f.worker.jobId}`;
        return {
          token,
          context: {
            ...execution,
            executionId: randomUUID(),
            worker: { type: 'worker' as const, id: workerId },
          },
        };
      };
      return {
        f,
        execution,
        definition,
        policyId,
        start,
        loaded,
        takeover,
        snapshot,
        value,
      };
    }

    it('heartbeats a long-running step only for the exact current job token, preserving input and absolute timeout', async () => {
      const s = await setup();
      const started = await s.start('load');
      await database.db`update allrice_workflow_step_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${started.step.id}`;
      const otherToken = randomUUID();
      await database.db`update allrice_workflow_step_runs set status='running',lease_token=${otherToken},
      lease_expires_at=clock_timestamp()-interval '1 second' where workflow_run_id=${started.step.workflowRunId} and step_key='save'`;
      const [before] =
        await database.db`select timeout_at from allrice_jobs where id=${s.f.worker.jobId}`;
      expect(
        await heartbeatJob(
          s.f.worker.workerId,
          s.f.worker.jobId,
          s.f.worker.leaseToken,
          30_000,
        ),
      ).toMatchObject({ active: true });
      const [step] =
        await database.db`select input_digest,lease_token,lease_expires_at>clock_timestamp() as live
      from allrice_workflow_step_runs where id=${started.step.id}`;
      expect(step).toMatchObject({
        input_digest: workflowDigest(s.value('load')),
        lease_token: s.f.worker.leaseToken,
        live: true,
      });
      const [other] =
        await database.db`select lease_token,lease_expires_at<clock_timestamp() as expired
      from allrice_workflow_step_runs where workflow_run_id=${started.step.workflowRunId} and step_key='save'`;
      expect(other).toMatchObject({ lease_token: otherToken, expired: true });
      const [after] =
        await database.db`select timeout_at from allrice_jobs where id=${s.f.worker.jobId}`;
      expect(after!.timeout_at).toEqual(before!.timeout_at);
    });

    it('resumes the same idempotent logical attempt and stable call ID after a new job incarnation, rejecting old late receipts', async () => {
      const s = await setup();
      await s.loaded();
      const interrupted = await s.start('save');
      await expect(s.start('save')).rejects.toMatchObject({
        code: 'lease_lost',
      });
      const next = await s.takeover();
      // The old step still bears the old token; current job ownership alone must
      // fence a late old complete/fail before another caller changes the step row.
      await expect(
        completeWorkflowStep({
          context: s.execution,
          stepId: interrupted.step.id,
          leaseToken: s.f.worker.leaseToken,
          output: { wrong: true },
        }),
      ).rejects.toMatchObject({ code: 'lease_lost' });
      await expect(
        failWorkflowStep({
          context: s.execution,
          stepId: interrupted.step.id,
          leaseToken: s.f.worker.leaseToken,
          code: 'LATE',
          message: 'late old worker',
        }),
      ).rejects.toMatchObject({ code: 'lease_lost' });
      const recovered = await s.start('save', next.context, next.token);
      expect(recovered).toMatchObject({
        replay: false,
        step: {
          id: interrupted.step.id,
          idempotencyKey: interrupted.step.idempotencyKey,
          attempt: 1,
          maxAttempts: 1,
        },
      });
      await completeWorkflowStep({
        context: next.context,
        stepId: recovered.step.id,
        leaseToken: next.token,
        output: { committed: true },
        sideEffectCommitted: true,
      });
      const run = await s.snapshot();
      expect(run.steps.map((step) => step.status)).toEqual([
        'succeeded',
        'succeeded',
      ]);
      expect(run.definition).toEqual(s.definition);
      expect((await s.start('save', next.context, next.token)).replay).toBe(
        true,
      );
      const [count] =
        await database.db`select count(*)::int as count from allrice_workflow_runs where run_id=${s.f.task.runId}`;
      expect(count!.count).toBe(1);
    });

    it('refuses changed frozen inputs on takeover without replacing the original row', async () => {
      const s = await setup();
      const before = await s.start('load');
      const next = await s.takeover();
      await expect(
        s.start('load', next.context, next.token, {
          ...s.value('load'),
          workflowInput: { exact: 'changed' },
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      const [row] =
        await database.db`select input_digest,lease_token from allrice_workflow_step_runs where id=${before.step.id}`;
      expect(row).toMatchObject({
        input_digest: before.step.inputDigest,
        lease_token: s.f.worker.leaseToken,
      });
    });

    it('requires durable dependencies and the exact Run/tenant even with a valid-looking job token', async () => {
      const s = await setup();
      await expect(s.start('save')).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        s.start('load', { ...s.execution, runId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'lease_lost' });
      await expect(
        s.start('load', { ...s.execution, organizationId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'lease_lost' });
      expect(
        (await s.snapshot()).steps.every((step) => step.status === 'pending'),
      ).toBe(true);
    });

    it('persists exhausted-attempt attention instead of rolling it back with the thrown control-flow error', async () => {
      const s = await setup();
      const run = await s.snapshot();
      const first = run.steps.find((step) => step.stepKey === 'load')!;
      await database.db`update allrice_workflow_step_runs set attempt=max_attempts where id=${first.id}`;
      await expect(s.start('load')).rejects.toMatchObject({
        code: 'needs_attention',
      });
      const after = await s.snapshot();
      expect(after.status).toBe('needs_attention');
      expect(after.steps.find((step) => step.id === first.id)).toMatchObject({
        status: 'needs_attention',
        errorCode: 'STEP_ATTEMPTS_EXHAUSTED',
      });
    });

    it('reuses a verified committed checkpoint instead of reissuing its side effect', async () => {
      const s = await setup();
      await s.loaded();
      const interrupted = await s.start('save');
      const output = { receipt: 'same immutable effect receipt' };
      await database.db`update allrice_workflow_step_runs set side_effect_committed=true,
      output=${database.db.json(output)},output_digest=${workflowDigest(output)} where id=${interrupted.step.id}`;
      const next = await s.takeover();
      const result = await s.start('save', next.context, next.token);
      expect(result).toMatchObject({
        replay: true,
        step: { id: interrupted.step.id, status: 'succeeded', output },
      });
      const [row] =
        await database.db`select lease_token from allrice_workflow_step_runs where id=${interrupted.step.id}`;
      expect(row!.lease_token).toBeNull();
    });

    it.each(['non_idempotent', 'manual'] as const)(
      'commits manual attention for an interrupted %s step without replaying',
      async (mode) => {
        const s = await setup(
          mode === 'manual'
            ? { recoveryPolicy: 'manual' }
            : { sideEffect: mode },
        );
        await s.loaded();
        const interrupted = await s.start('save');
        const next = await s.takeover();
        await expect(
          s.start('save', next.context, next.token),
        ).rejects.toMatchObject({ code: 'needs_attention' });
        const run = await s.snapshot();
        expect(run.status).toBe('needs_attention');
        expect(
          run.steps.find((step) => step.id === interrupted.step.id),
        ).toMatchObject({
          status: 'needs_attention',
          attempt: 1,
          errorCode: 'STEP_RECOVERY_REQUIRES_ATTENTION',
        });
      },
    );

    it.each([
      'expired_job',
      'expired_policy',
      'canceled_job',
      'canceled_root',
      'expired_root',
    ] as const)(
      'denies recovery and late completion when %s is authoritative',
      async (cause) => {
        const s = await setup();
        const started = await s.start('load');
        if (cause === 'expired_job')
          await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${s.f.worker.jobId}`;
        if (cause === 'expired_policy')
          await database.db`update allrice_policy_snapshots set issued_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where id=${s.policyId}`;
        if (cause === 'canceled_job')
          await database.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${s.f.worker.jobId}`;
        if (cause === 'canceled_root')
          await database.db`update allrice_runtime_roots set cancel_requested_at=clock_timestamp(),
          cancel_request_id=${randomUUID()},cancel_reason='user_request' where root_run_id=${s.f.task.runId}`;
        if (cause === 'expired_root')
          await database.db`update allrice_runtime_roots set deadline_at=clock_timestamp()-interval '1 second' where root_run_id=${s.f.task.runId}`;
        await expect(s.start('load')).rejects.toMatchObject({
          code: 'lease_lost',
        });
        await expect(
          completeWorkflowStep({
            context: s.execution,
            stepId: started.step.id,
            leaseToken: s.f.worker.leaseToken,
            output: 'late',
          }),
        ).rejects.toMatchObject({ code: 'lease_lost' });
        const run = await s.snapshot();
        expect(
          run.steps.find((step) => step.id === started.step.id)?.status,
        ).toBe('running');
      },
    );
  },
);
