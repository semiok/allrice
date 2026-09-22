/** Synthetic Bridge target + real PostgreSQL authority/approval/lease tests.
 * No VM, command process, customer data, external credential or deployment. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RuntimeLocalCommandToolInputSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import { assertAssistantAuthority } from './assistant-authority.ts';
import {
  createLocalCommandOperation,
  waitLocalCommandOperation,
} from './local-command-service.ts';
import {
  requestRuntimeActionApproval,
  decideRuntimeActionApproval,
  setRuntimePolicyControls,
} from './runtime-policy.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const flags = [
  'ALLRICE_ASSISTANTS_ENABLED',
  'ALLRICE_LOCAL_COMMAND_ENABLED',
  'ALLRICE_RUNTIME_POLICY_ENABLED',
  'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
integration(
  'P25 assistant local-command proposal authority — isolated real PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    const previous = Object.fromEntries(
      flags.map((name) => [name, process.env[name]]),
    );
    beforeAll(async () => {
      for (const name of flags) process.env[name] = '1';
      fixture = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      for (const name of flags) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      await fixture?.close();
    });

    const proposalFixture = async (
      effect: 'ask' | 'allow' = 'ask',
      project = false,
    ) => {
      const f = await createAssistantLocalCommandFixture(
        fixture.db,
        effect,
        project,
      );
      if (!f.child) throw Error('Expected configured fixture child');
      return { ...f, child: f.child };
    };

    it('defers the synthetic ledger so production must create the first root and child', async () => {
      const f = await createAssistantLocalCommandFixture(
        fixture.db,
        'ask',
        false,
        {
          deferRuntimeRoot: true,
          nativeSessionId: 'synthetic-production-root',
        },
      );
      expect(f.child).toBeNull();
      expect(
        await f.db`select 1 from allrice_runtime_roots where root_run_id=${f.rootRunId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select 1 from allrice_runtime_budgets where root_run_id=${f.rootRunId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select 1 from allrice_employee_runs where run_id=${f.rootRunId}`,
      ).toHaveLength(1);
      expect(() => f.create()).toThrow(
        'Explicit production native child required',
      );
    });
    type Fixture = Awaited<ReturnType<typeof proposalFixture>>;
    type Created = Awaited<ReturnType<Fixture['create']>>;
    const dispatch = (f: Fixture, c: Created, ledger = f.freshLedger()) =>
      ledger.dispatch({
        scope: f.task.scope,
        operationId: c.snapshot.binding.attempt.operationId,
        leaseOwner: randomUUID(),
        leaseMs: 30000,
      });

    it.each([0, 124])(
      'settles a terminal assistant command exactly once, exit %s',
      async (exitCode) => {
        const f = await proposalFixture(),
          c = await f.create();
        const operationId = c.snapshot.binding.attempt.operationId;
        await f.approve(await f.approvalFor(operationId));
        const ledger = f.freshLedger(),
          lease = await dispatch(f, c, ledger);
        const identity = {
          scope: f.task.scope,
          operationId,
          leaseToken: lease.leaseToken,
          attempt: lease.snapshot.binding.attempt,
        };
        await ledger.startOperation({ ...identity, receiptId: randomUUID() });
        const unsettled = () =>
          f.db`select metric from allrice_runtime_reservations where operation_id=${operationId} and settled_amount is null`;
        await ledger.recordReceipt({
          ...identity,
          receiptId: randomUUID(),
          signal: { type: 'operation.uncertain', reason: 'connection_lost' },
        });
        expect(await unsettled()).toHaveLength(4);
        const receipt = {
          ...identity,
          receiptId: randomUUID(),
          signal: {
            type: 'operation.outcome' as const,
            result: {
              status:
                exitCode === 0 ? ('succeeded' as const) : ('failed' as const),
              effects: 'none' as const,
              evidence: {
                id: randomUUID(),
                recordedAt: new Date().toISOString(),
                digest: `sha256:${'a'.repeat(64)}`,
              },
            },
          },
          evidence: {
            output: {
              backend: 'local-vm-container-v1',
              containerId: 'b'.repeat(64),
              imageDigest: localCommandToolchainImageV1,
              stopped: true,
              exitCode,
              reason: exitCode === 0 ? 'exited' : 'timeout',
              stdout: '',
              stderr: '',
              truncated: false,
              workCopy: 'local_isolated_copy',
              sourceDirectoryModified: false,
            },
          },
        };
        await expect(
          ledger.recordReceipt({
            ...receipt,
            receiptId: randomUUID(),
            leaseToken: 'wrong',
          }),
        ).rejects.toThrow();
        expect(await unsettled()).toHaveLength(4);
        expect(
          (
            await ledger.recordReceipt({
              ...receipt,
              receiptId: randomUUID(),
              attempt: { ...identity.attempt, attemptId: randomUUID() },
            })
          ).disposition,
        ).toBe('stale');
        expect(await unsettled()).toHaveLength(4);
        expect((await ledger.recordReceipt(receipt)).disposition).toBe(
          'applied',
        );
        expect(await unsettled()).toHaveLength(0);
        const observations =
          await f.db`select metric,settled_amount,observation from allrice_runtime_reservations where operation_id=${operationId} order by metric`;
        expect(observations.map((r) => [r.metric, r.settled_amount])).toEqual([
          ['input_tokens', '0'],
          ['model_calls', '0'],
          ['output_tokens', '0'],
          ['tool_calls', '1'],
        ]);
        const budgets =
          await f.db`select metric,spent,reserved from allrice_runtime_budgets where root_run_id=${f.rootRunId} order by metric`;
        expect((await ledger.recordReceipt(receipt)).disposition).toBe(
          'duplicate',
        );
        expect(
          await f.db`select metric,settled_amount,observation from allrice_runtime_reservations where operation_id=${operationId} order by metric`,
        ).toEqual(observations);
        expect(
          await f.db`select metric,spent,reserved from allrice_runtime_budgets where root_run_id=${f.rootRunId} order by metric`,
        ).toEqual(budgets);
      },
    );

    it('does not invent measured usage from a terminal error without a process receipt', async () => {
      const f = await proposalFixture(),
        c = await f.create();
      const operationId = c.snapshot.binding.attempt.operationId;
      await f.approve(await f.approvalFor(operationId));
      const ledger = f.freshLedger(),
        lease = await dispatch(f, c, ledger);
      const identity = {
        scope: f.task.scope,
        operationId,
        leaseToken: lease.leaseToken,
        attempt: lease.snapshot.binding.attempt,
      };
      await ledger.startOperation({ ...identity, receiptId: randomUUID() });
      await ledger.recordReceipt({
        ...identity,
        receiptId: randomUUID(),
        signal: {
          type: 'operation.outcome',
          result: {
            status: 'failed',
            effects: 'none',
            evidence: {
              id: randomUUID(),
              recordedAt: new Date().toISOString(),
              digest: `sha256:${'a'.repeat(64)}`,
            },
          },
        },
        evidence: { error: 'runner_unavailable' },
      });
      expect(
        await f.db`select metric from allrice_runtime_reservations where operation_id=${operationId} and settled_amount is null`,
      ).toHaveLength(4);
    });

    it('keeps public arguments free of Worker provenance and binds immutable operation origin to the real child', async () => {
      const f = await proposalFixture();
      expect(
        RuntimeLocalCommandToolInputSchema.safeParse({
          ...f.args,
          assistant: { runId: f.child.runId, worker: f.worker },
        }).success,
      ).toBe(false);
      const c = await f.create('same-call');
      expect(c.snapshot.agentInstanceId).toBe(f.child.runId);
      expect(c.snapshot.binding.task.runId).toBe(f.rootRunId);
      expect(c.snapshot.binding.task.rootRunId).toBe(f.rootRunId);
      expect(c.snapshot.status).toBe('waiting_user');
      const approval = await f.approvalFor(
        c.snapshot.binding.attempt.operationId,
      );
      expect(approval.task.runId).toBe(f.rootRunId);
      expect(approval.binding).toEqual(c.snapshot.binding);
      const before =
        await f.db`select metric,amount from allrice_runtime_reservations where operation_id=${c.snapshot.binding.attempt.operationId} order by metric`;
      expect(before.map((r) => [r.metric, Number(r.amount)])).toEqual([
        ['input_tokens', 0],
        ['model_calls', 0],
        ['output_tokens', 0],
        ['tool_calls', 1],
      ]);
      await expect(f.create('same-call')).resolves.toMatchObject({
        snapshot: { agentInstanceId: f.child.runId },
      });
      expect(
        await f.db`select id from allrice_runtime_operations where root_run_id=${f.rootRunId}`,
      ).toHaveLength(1);
      await expect(dispatch(f, c)).rejects.toThrow('unavailable');
      await f.approve(approval);
      const lease = await dispatch(f, c);
      expect(lease.snapshot.status).toBe('dispatched');
      expect(lease.snapshot.agentInstanceId).toBe(f.child.runId);
    });

    it('does not reuse a sibling or root operation identity for the same native call ID', async () => {
      const f = await proposalFixture();
      const sibling = (
        await f.runtime.provision({
          ...f.base,
          parentRunId: f.rootRunId,
          delegationId: randomUUID(),
          label: 'Sibling',
          text: 'Synthetic',
          tools: ['local.process.execute'],
        })
      ).instance;
      const a = await f.create('collision'),
        b = await f.create('collision', {
          runId: sibling.runId,
          worker: f.worker,
        });
      const root = await createLocalCommandOperation(
        { context: f.context, arguments: f.args, callId: 'collision' },
        f.db,
      );
      expect(
        new Set([
          a.snapshot.binding.attempt.operationId,
          b.snapshot.binding.attempt.operationId,
          root.snapshot.binding.attempt.operationId,
        ]).size,
      ).toBe(3);
      expect(root.snapshot.agentInstanceId).toBeNull();
    });

    it('a rejected child proposal cancels only its own pending operations, preserving Rice and siblings', async () => {
      const f = await proposalFixture(),
        rejected = await f.create();
      const sibling = (
        await f.runtime.provision({
          ...f.base,
          parentRunId: f.rootRunId,
          delegationId: randomUUID(),
          label: 'Sibling survives',
          text: 'Synthetic',
          tools: ['local.process.execute'],
        })
      ).instance;
      const siblingOperation = await f.create('sibling', {
        runId: sibling.runId,
        worker: f.worker,
      });
      const request = await f.approvalFor(
        rejected.snapshot.binding.attempt.operationId,
      );
      await decideRuntimeActionApproval(
        f.requestContext,
        request.approvalId,
        {
          contractVersion: 1,
          direction: 'response',
          kind: 'action_approval',
          requestId: request.requestId,
          version: request.version,
          requestDigest: request.requestDigest,
          task: request.task,
          responseId: randomUUID(),
          respondedBy: f.user,
          respondedAt: new Date().toISOString(),
          approvalId: request.approvalId,
          decision: 'rejected',
        },
        f.db,
      );
      const result = await waitLocalCommandOperation(rejected, undefined, f.db);
      expect(result).toMatchObject({
        status: 'canceled',
        evidence: { output: { notExecuted: true } },
      });
      const [root] =
        await f.db`select cancel_request_id from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
      expect(root!.cancel_request_id).toBeNull();
      const tree = await f.runtime.getTree(f.requestContext, {
        runId: f.rootRunId,
      });
      expect(tree.instances.every((i) => i.cancelRequestedAt === null)).toBe(
        true,
      );
      expect(
        (
          await f
            .freshLedger()
            .readOperation(
              f.task.scope,
              siblingOperation.snapshot.binding.attempt.operationId,
            )
        ).status,
      ).toBe('waiting_user');
      await expect(f.authorize('model', [])).resolves.toBeUndefined();
    });

    it('rejects fake children, root-as-child, foreign child and narrowed tool scope before creating operations', async () => {
      const f = await proposalFixture(),
        other = await proposalFixture();
      for (const runId of [randomUUID(), f.rootRunId, other.child.runId])
        await expect(
          f.create(randomUUID(), { runId, worker: f.worker }),
        ).rejects.toThrow();
      const readOnly = (
        await f.runtime.provision({
          ...f.base,
          parentRunId: f.rootRunId,
          delegationId: randomUUID(),
          label: 'Read only',
          text: 'Synthetic',
          tools: ['web.fetch'],
        })
      ).instance;
      await expect(
        f.create(randomUUID(), { runId: readOnly.runId, worker: f.worker }),
      ).rejects.toThrow('assistant_authority_changed');
      expect(
        await f.db`select id from allrice_runtime_operations where root_run_id=${f.rootRunId}`,
      ).toHaveLength(0);
    });
    it.each([
      'jobId',
      'workerId',
      'leaseToken',
      'generation',
      'fence',
    ] as const)(
      'rejects a stale/forged Worker %s at the trusted entrypoint',
      async (field) => {
        const f = await proposalFixture();
        const worker = {
          ...f.worker,
          [field]: ['generation', 'fence'].includes(field) ? 99 : randomUUID(),
        };
        await expect(
          f.create(randomUUID(), { runId: f.child.runId, worker }),
        ).rejects.toThrow('assistant_authority_changed');
        expect(
          await f.db`select id from allrice_runtime_operations where root_run_id=${f.rootRunId}`,
        ).toHaveLength(0);
      },
    );

    const revocations: [string, (f: Fixture) => Promise<unknown>][] = [
      [
        'membership',
        (f) =>
          f.db`update allrice_memberships set active=false where id=${f.membership}`,
      ],
      [
        'assignment',
        (f) =>
          f.db`update allrice_employee_assignments set active=false where id=${f.assignment}`,
      ],
      [
        'employee',
        (f) =>
          f.db`update allrice_employees set status='archived' where id=${f.employee}`,
      ],
      [
        'child cancel',
        (f) =>
          f.runtime.cancelChild(f.requestContext, {
            runId: f.rootRunId,
            childRunId: f.child.runId,
            requestId: randomUUID(),
          }),
      ],
      [
        'job lease',
        (f) =>
          f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`,
      ],
      [
        'generation',
        (f) =>
          f.db`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`,
      ],
      [
        'assistant quarantine',
        (f) =>
          f.db`update allrice_assistant_roots set revoked_at=clock_timestamp(),fence=fence+1 where root_run_id=${f.rootRunId}`,
      ],
    ];
    it.each(revocations)(
      'reconstructs immutable child authority for dispatch after %s',
      async (_name, revoke) => {
        const f = await proposalFixture(),
          c = await f.create();
        await f.approve(
          await f.approvalFor(c.snapshot.binding.attempt.operationId),
        );
        await revoke(f);
        await expect(dispatch(f, c)).rejects.toThrow();
        const [row] =
          await f.db`select lease_token_hash from allrice_runtime_operations where id=${c.snapshot.binding.attempt.operationId}`;
        expect(row!.lease_token_hash).toBeNull();
      },
    );
    it('refuses a new heartbeat after live child authority disappears, without declaring a dispatched process stopped', async () => {
      const f = await proposalFixture(),
        c = await f.create();
      await f.approve(
        await f.approvalFor(c.snapshot.binding.attempt.operationId),
      );
      const lease = await dispatch(f, c);
      await f.db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
      await expect(
        f.freshLedger().heartbeat({
          scope: f.task.scope,
          operationId: c.snapshot.binding.attempt.operationId,
          leaseToken: lease.leaseToken,
          leaseMs: 30000,
        }),
      ).rejects.toThrow('unavailable');
      const [row] =
        await f.db`select snapshot->>'status' as status from allrice_runtime_operations where id=${c.snapshot.binding.attempt.operationId}`;
      expect(row!.status).toBe('dispatched');
    });
    it('rejects unsupported assistant background services before any operation or approval exists', async () => {
      const f = await proposalFixture();
      await expect(
        f.create(
          randomUUID(),
          { runId: f.child.runId, worker: f.worker },
          {
            ...f.args,
            background: {
              durationMs: 10000,
              readiness: {
                kind: 'tcp',
                port: 3000,
                path: '/',
                timeoutMs: 1000,
              },
              stdin: {
                mode: 'none',
                maxRequests: 1,
                maxBytes: 128,
                requestTimeoutMs: 1000,
              },
            },
          },
        ),
      ).rejects.toThrow('assistant_authority_changed');
      expect(
        await f.db`select id from allrice_runtime_operations where root_run_id=${f.rootRunId}`,
      ).toHaveLength(0);
    });

    it('preserves the actual project scope and rejects a child redirected across projects', async () => {
      const f = await proposalFixture('ask', true);
      const c = await f.create();
      expect(c.snapshot.binding.task.scope.projectId).toBe(
        f.task.scope.projectId,
      );
      await f.approve(
        await f.approvalFor(c.snapshot.binding.attempt.operationId),
      );
      const lease = await dispatch(f, c);
      expect(lease.snapshot.agentInstanceId).toBe(f.child.runId);
      const foreignProject = randomUUID();
      await f.db`insert into allrice_projects(id,organization_id,workspace_id,owner_id,name) values(${foreignProject},${f.org},${f.workspace},${f.user},'Other synthetic project')`;
      const wrongTask = {
        ...f.task,
        runId: f.child.runId,
        parentRunId: f.rootRunId,
        scope: { ...f.task.scope, projectId: foreignProject },
      };
      await f.db`update allrice_runtime_run_links set task=${f.db.json(wrongTask)} where run_id=${f.child.runId}`;
      await expect(f.create('cross-project')).rejects.toThrow(
        'assistant_authority_changed',
      );
    });

    it('rejects a new token reusing the same Worker ID for an old assistant incarnation', async () => {
      const f = await proposalFixture(),
        c = await f.create();
      await f.approve(
        await f.approvalFor(c.snapshot.binding.attempt.operationId),
      );
      const leaseToken = randomUUID();
      await f.db`update allrice_jobs set lease_token=${leaseToken} where id=${f.worker.jobId}`;
      await expect(
        f.create('new-incarnation', {
          runId: f.child.runId,
          worker: { ...f.worker, leaseToken },
        }),
      ).rejects.toThrow('assistant_authority_changed');
      await expect(dispatch(f, c)).rejects.toThrow('unavailable');
      await expect(f.authorize('model', [])).rejects.toThrow(
        'assistant_authority_denied',
      );
    });

    it('orders concurrent approval creation behind the delegate root lock before controls', async () => {
      const f = await proposalFixture(),
        c = await f.create();
      const hold = deferred(),
        entered = deferred(),
        approvalAttempted = deferred();
      const holder = f.db.begin(async (tx) => {
        await tx`select root_run_id from allrice_runtime_roots where root_run_id=${f.rootRunId} for update`;
        entered.resolve();
        await hold.promise;
        await assertAssistantAuthority({
          transaction: tx,
          task: f.task,
          tools: ['local.process.execute'],
          phase: 'delegate',
        });
      });
      await entered.promise;
      const options = f.freshLedger().policyOptions,
        lock = options.lockCurrentBinding!;
      options.lockCurrentBinding = async (input) => {
        approvalAttempted.resolve();
        await lock(input);
      };
      const approval = requestRuntimeActionApproval(
        options,
        c.snapshot.binding,
        600000,
        f.db,
      );
      await approvalAttempted.promise;
      hold.resolve();
      const [, request] = await Promise.all([holder, approval]);
      expect(request.binding).toEqual(c.snapshot.binding);
    }, 10000);

    it('rechecks actual lease time after an approval-row lock wait before dispatch commits', async () => {
      const f = await proposalFixture(),
        c = await f.create(),
        request = await f.approvalFor(c.snapshot.binding.attempt.operationId);
      await f.approve(request);
      await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '650 milliseconds' where id=${f.worker.jobId}`;
      const locked = deferred(),
        release = deferred(),
        resolved = deferred();
      const holder = f.db.begin(async (tx) => {
        await tx`select id from allrice_approval_requests where id=${request.approvalId} for update`;
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const ledger = f.freshLedger(),
        original = ledger.policyOptions.resolveCurrentBinding;
      ledger.policyOptions.resolveCurrentBinding = async (input) => {
        const result = await original(input);
        resolved.resolve();
        return result;
      };
      const pending = dispatch(f, c, ledger);
      const rejected = expect(pending).rejects.toThrow('unavailable');
      await resolved.promise;
      await new Promise((r) => setTimeout(r, 750));
      release.resolve();
      await Promise.all([holder, rejected]);
      const [row] =
        await f.db`select lease_token_hash from allrice_runtime_operations where id=${c.snapshot.binding.attempt.operationId}`;
      expect(row!.lease_token_hash).toBeNull();
      const [approval] =
        await f.db`select runtime_consumed_at from allrice_approval_requests where id=${request.approvalId}`;
      expect(approval!.runtime_consumed_at).toBeNull();
    }, 10000);

    it('serializes concurrent proposal creation, delegate, approval and live policy revocation without granting stale execution', async () => {
      const f = await proposalFixture(),
        c = await f.create();
      const outcomes = await Promise.allSettled([
        f.create('concurrent'),
        f.runtime.provision({
          ...f.base,
          parentRunId: f.rootRunId,
          delegationId: randomUUID(),
          label: 'Concurrent',
          text: 'Synthetic',
          tools: ['local.process.execute'],
        }),
        requestRuntimeActionApproval(
          f.freshLedger().policyOptions,
          c.snapshot.binding,
          600000,
          f.db,
        ),
        setRuntimePolicyControls(
          f.requestContext,
          {
            version: 2,
            enabled: true,
            mode: 'execute',
            rules: [
              { action: 'assistant.delegate', effect: 'deny' },
              { action: 'local.process.execute', effect: 'deny' },
            ],
          },
          1,
          f.db,
        ),
      ]);
      for (const outcome of outcomes)
        if (outcome.status === 'rejected')
          expect(String(outcome.reason)).not.toMatch(/deadlock|40P01|timeout/);
      expect(outcomes[3]!.status).toBe('fulfilled');
      await expect(dispatch(f, c)).rejects.toThrow('unavailable');
      await expect(f.create('after-revoke')).rejects.toThrow(
        'assistant_authority_changed',
      );
    }, 10000);
  },
);
