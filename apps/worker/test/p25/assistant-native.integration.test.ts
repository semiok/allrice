import { randomUUID } from 'node:crypto';
import type { AssistantInstanceView } from '@allrice/contracts';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { closeDatabase } from '../../../../packages/database/src/core/client.ts';
import {
  cancelRun,
  heartbeatJob,
  maintainQueue,
  finishJobDrain,
} from '../../../../packages/database/src/execution/queue.ts';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantWorkerBridge } from '../../src/harness/dsh/assistant-bridge.js';
import { assistantNativeCheckpointEvidence } from '../../src/harness/dsh/assistant-recovery.js';
import { p24Fixture, gate, latestTaskMessage } from '../p24/fixture.js';
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('P25 actual native DSH + PostgreSQL governed adapter', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    process.env.ALLRICE_ASSISTANTS_ENABLED = '1';
    database = await createAssistantFixtureDatabase();
    const [scope] = await database.db<
      { schema: string }[]
    >`select current_schema() schema`;
    const schema = scope!.schema;
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    url.searchParams.set('options', '-csearch_path=' + schema + ',public');
    vi.stubEnv('DATABASE_URL', url.href);
  }, 120000);
  afterAll(async () => {
    delete process.env.ALLRICE_ASSISTANTS_ENABLED;
    await closeDatabase();
    await database?.close();
    vi.unstubAllEnvs();
  });
  it('trusted host provisions two native independent children; reservations, child identities and durable parent adoption survive queries', async () => {
    const f = await assistantFixture(database.db, 20);
    const wireNames = {
      'assistant.delegate': 'assistant_delegate',
      'assistant.report': 'assistant_report',
      read: 'p24_proposal',
    };
    const bridge = createAssistantWorkerBridge({
      runtime: f.runtime,
      task: f.task,
      context: f.context,
      worker: f.worker,
      wireNames,
      readOnlyTools: new Set(),
    });
    const native = await p24Fixture(
      async (request) => {
        const payload = JSON.stringify(request.messages),
          last = latestTaskMessage(request);
        if (payload.includes('ANALYZE_A') && !payload.includes('ROOT_PRIVATE'))
          return {
            nativeTool: {
              name: 'assistant_report',
              arguments: {
                status: 'partial',
                summary: 'A: synthetic 2+3=5 checked',
                evidence: [],
                incomplete: ['awaiting parent verification'],
              },
            },
          };
        if (payload.includes('ANALYZE_B') && !payload.includes('ROOT_PRIVATE'))
          return {
            nativeTool: {
              name: 'assistant_report',
              arguments: {
                status: 'partial',
                summary: 'B: synthetic 4+6=10 checked',
                evidence: [],
                incomplete: ['awaiting parent verification'],
              },
            },
          };
        if (
          last?.role === 'user' &&
          payload.includes('ROOT_PRIVATE') &&
          !payload.includes('subagent')
        )
          return { text: 'Parent context stays private.' };
        return { text: 'Parent received and compared the two summaries.' };
      },
      undefined,
      { p25: true, callback: bridge.handle },
    );
    const client = native.launch();
    try {
      await client.call('ready');
      await client.call('create', { id: f.nativeSessionId });
      await client.call('p25/bind', { nativeSessionId: f.nativeSessionId });
      await client.call('prompt', {
        id: f.nativeSessionId,
        text: 'ROOT_PRIVATE only parent context',
      });
      await client.call('idle', { id: f.nativeSessionId });
      const children = await Promise.all(
        ['A', 'B'].map(async (label) => {
          const id = randomUUID();
          const child = await f.delegate({
            delegationId: id,
            label,
            text: `ANALYZE_${label}`,
            tools: ['assistant.report'],
          });
          const p = await bridge.messageDispatch(id);
          await client.call('p25/start', p);
          return child.instance;
        }),
      );
      await expect
        .poll(async () => (await bridge.tree()).results.length, {
          timeout: 20000,
        })
        .toBe(2);
      await expect
        .poll(
          async () =>
            (await bridge.tree()).results.filter(
              (r) => r.parentAdoptedSeq !== null,
            ).length,
          { timeout: 20000 },
        )
        .toBe(2);
      const tree = await bridge.tree();
      expect(tree.instances).toHaveLength(3);
      expect(tree.messages.every((m) => m.status === 'adopted')).toBe(true);
      expect(
        tree.budgets.find((b) => b.metric === 'model_calls')!.spent,
      ).toBeGreaterThanOrEqual(4);
      expect(tree.results.every((r) => r.status === 'partial')).toBe(true);
      // A later business Run can bind the same persistent root Session without
      // carrying a prior Run's native authority maps or child wakeups forward.
      await client.call('p25/join', { nativeSessionId: f.nativeSessionId });
      // Durable adoption alone is not enough: both governed summaries must
      // survive the actual native notice -> provider request conversion.
      expect(
        native.requests.some((request) => {
          const visible = JSON.stringify(request.messages);
          return (
            visible.includes('ROOT_PRIVATE') &&
            visible.includes('A: synthetic 2+3=5 checked') &&
            visible.includes('B: synthetic 4+6=10 checked') &&
            visible.includes('awaiting parent verification')
          );
        }),
      ).toBe(true);
      await client.call('p25/finish', { nativeSessionId: f.nativeSessionId });
      await expect(
        client.call('p25/bind', { nativeSessionId: f.nativeSessionId }),
      ).resolves.toMatchObject({ bound: true });
      for (const child of children) {
        const proof = await client.call<{
          events: { type: string; data: { policy?: string } }[];
        }>('p25/inspect', { nativeSessionId: child.nativeSessionId });
        expect(proof.events).toContainEqual(
          expect.objectContaining({
            type: 'approval/policy',
            data: expect.objectContaining({ policy: 'never' }),
          }),
        );
      }
      expect(
        native.requests
          .filter(
            (r) =>
              JSON.stringify(r).includes('ANALYZE_A') &&
              !JSON.stringify(r).includes('subagent-settled'),
          )
          .every((r) => !JSON.stringify(r).includes('ROOT_PRIVATE')),
      ).toBe(true);
    } finally {
      await native.close();
    }
  }, 60000);
  it('durable root tombstone blocks late native model wake and queues before real child-first drain', async () => {
    const f = await assistantFixture(database.db),
      hold = gate();
    const bridge = createAssistantWorkerBridge({
      runtime: f.runtime,
      task: f.task,
      context: f.context,
      worker: f.worker,
      wireNames: { read: 'p24_proposal' },
      readOnlyTools: new Set(),
    });
    const native = await p24Fixture(
      async () => {
        await hold.promise;
        return { text: 'Late response' };
      },
      undefined,
      { p25: true, callback: bridge.handle },
    );
    const client = native.launch();
    try {
      await client.call('ready');
      await client.call('create', { id: f.nativeSessionId });
      await client.call('p25/bind', { nativeSessionId: f.nativeSessionId });
      const id = randomUUID();
      await f.delegate({ delegationId: id });
      await client.call('p25/start', await bridge.messageDispatch(id));
      await expect.poll(() => native.requests.length).toBe(1);
      await f.runtime.cancelRoot(f.context, {
        runId: f.task.runId,
        requestId: randomUUID(),
      });
      await client.call('p25/drain', await bridge.cancellation());
      hold.release();
      await client.call('p25/flush');
      expect(native.requests).toHaveLength(1);
      expect(
        (await bridge.tree()).instances.every((i) => i.status === 'canceled'),
      ).toBe(true);
    } finally {
      hold.release();
      await native.close();
    }
  }, 60000);
  it.each(['heartbeat', 'maintenance', 'authority-timeout', 'crash'] as const)(
    'ordinary cancellation survives %s until actual native child-first stopped receipts',
    async (trigger) => {
      const f = await assistantFixture(database.db),
        hold = gate();
      f.context.memberships = (
        await database.db`select * from allrice_memberships where user_id=${f.context.actor.id}`
      ).map((m) => ({
        id: m.id,
        userId: m.user_id,
        organizationId: m.organization_id,
        workspaceId: m.workspace_id,
        role: m.role,
        active: m.active,
      }));
      const bridge = createAssistantWorkerBridge({
        runtime: f.runtime,
        task: f.task,
        context: f.context,
        worker: f.worker,
        wireNames: { read: 'p24_proposal' },
        readOnlyTools: new Set(),
      });
      const stopped = new Set<string>();
      const native = await p24Fixture(
        async () => {
          await hold.promise;
          return { text: 'Late synthetic response' };
        },
        undefined,
        {
          p25: true,
          callback: async (method, p) => {
            const result = await bridge.handle(method, p);
            if (method === 'stopped' && result.stopped === true)
              stopped.add(String(p.nativeSessionId));
            return result;
          },
        },
      );
      const client = native.launch();
      try {
        await client.call('ready');
        await client.call('create', { id: f.nativeSessionId });
        await client.call('p25/bind', { nativeSessionId: f.nativeSessionId });
        const id = randomUUID();
        await f.delegate({ delegationId: id });
        await client.call('p25/start', await bridge.messageDispatch(id));
        await expect.poll(() => native.requests.length).toBe(1);
        if (trigger === 'authority-timeout')
          await database.db`update allrice_jobs set created_at=clock_timestamp()-interval '2 seconds',timeout_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
        else
          await cancelRun(f.context, f.context.workspaceId!, f.task.runId, {
            reason: 'user_requested',
          });
        if (trigger === 'heartbeat')
          expect(
            await heartbeatJob(
              f.worker.workerId,
              f.worker.jobId,
              f.worker.leaseToken,
              30000,
            ),
          ).toMatchObject({ active: false, draining: true });
        else if (trigger === 'maintenance') await maintainQueue();
        if (trigger === 'crash') {
          await client.crash();
          hold.release();
          await database.db`update allrice_jobs set drain_deadline_at=clock_timestamp()-interval '1 second',lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
          await maintainQueue();
          const [job] =
            await database.db`select status from allrice_jobs where id=${f.worker.jobId}`;
          expect(job!.status).toBe('canceled');
          expect(stopped.size).toBe(0);
          const rows =
            await database.db`select stopped_at from allrice_assistant_instances where root_run_id=${f.task.runId}`;
          expect(rows.every((row) => row.stopped_at === null)).toBe(true);
          const calls =
            await database.db`select finished_at from allrice_assistant_model_admissions where root_run_id=${f.task.runId}`;
          expect(calls.some((call) => call.finished_at === null)).toBe(true);
          return;
        }
        const request = await bridge.cancellation();
        expect(request.drainDeadlineAt).toEqual(expect.any(String));
        await client.call('p25/drain', request);
        hold.release();
        await client.call('p25/flush');
        const rows =
          await database.db`select native_session_id,stopped_at from allrice_assistant_instances where root_run_id=${f.task.runId}`;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(stopped.has(row.native_session_id)).toBe(true);
          expect(row.stopped_at).not.toBeNull();
        }
        expect(native.requests).toHaveLength(1);
        expect(
          (
            await database.db`select status from allrice_jobs where id=${f.worker.jobId}`
          )[0]!.status,
        ).toBe('running');
        await finishJobDrain(f.worker);
        expect(
          (
            await database.db`select status from allrice_jobs where id=${f.worker.jobId}`
          )[0]!.status,
        ).toBe(trigger === 'authority-timeout' ? 'failed' : 'canceled');
      } finally {
        hold.release();
        await native.close();
      }
    },
    60000,
  );
  it('canceling one actually-running native child never drains its parent or sibling', async () => {
    const f = await assistantFixture(database.db),
      holdA = gate(),
      holdB = gate();
    const bridge = createAssistantWorkerBridge({
      runtime: f.runtime,
      task: f.task,
      context: f.context,
      worker: f.worker,
      wireNames: { read: 'p24_proposal' },
      readOnlyTools: new Set(),
    });
    const native = await p24Fixture(
      async (request) => {
        const payload = JSON.stringify(request.messages);
        if (!payload.includes('ROOT_PRIVATE'))
          await (payload.includes('CHILD_A') ? holdA : holdB).promise;
        return { text: 'Synthetic native result' };
      },
      undefined,
      { p25: true, callback: bridge.handle },
    );
    const client = native.launch();
    try {
      await client.call('ready');
      await client.call('create', { id: f.nativeSessionId });
      await client.call('p25/bind', { nativeSessionId: f.nativeSessionId });
      await client.call('prompt', {
        id: f.nativeSessionId,
        text: 'ROOT_PRIVATE',
      });
      await client.call('idle', { id: f.nativeSessionId });
      const children: AssistantInstanceView[] = [];
      for (const label of ['A', 'B']) {
        const delegationId = randomUUID();
        const child = await f.delegate({
          delegationId,
          text: `CHILD_${label}`,
        });
        children.push(child.instance);
        await client.call(
          'p25/start',
          await bridge.messageDispatch(delegationId),
        );
      }
      await expect.poll(() => native.requests.length).toBe(3);
      await f.runtime.cancelChild(f.context, {
        runId: f.task.runId,
        childRunId: children[0]!.runId,
        requestId: randomUUID(),
      });
      await client.call('p25/drain', await bridge.cancellation());
      expect((await client.snapshot(f.nativeSessionId)).live).toBe(true);
      expect((await client.snapshot(children[1]!.nativeSessionId)).status).toBe(
        'running',
      );
      expect(
        (await bridge.tree()).instances.find((i) => i.runId === f.task.runId)
          ?.cancelRequestedAt,
      ).toBeNull();
      holdA.release();
      holdB.release();
      await expect
        .poll(
          async () =>
            (await bridge.tree()).results.some(
              (r) =>
                r.runId === children[1]!.runId && r.parentAdoptedSeq !== null,
            ),
          { timeout: 15000 },
        )
        .toBe(true);
      expect(
        (await bridge.tree()).instances.find(
          (i) => i.runId === children[0]!.runId,
        )?.status,
      ).toBe('canceled');
    } finally {
      holdA.release();
      holdB.release();
      await native.close();
    }
  }, 60000);
  it('a parent that stops one child keeps working when that child settles after its stop receipt', async () => {
    const f = await assistantFixture(database.db, 12, {
        allowedTools: [
          'read',
          'assistant.delegate',
          'assistant.report',
          'assistant.stop',
        ],
      }),
      holdA = gate(),
      holdB = gate(),
      stoppedA = gate(),
      settleA = gate();
    const children: AssistantInstanceView[] = [];
    const settled = new Map<string, string>();
    const bridge = createAssistantWorkerBridge({
      runtime: f.runtime,
      task: f.task,
      context: f.context,
      worker: f.worker,
      wireNames: { read: 'p24_proposal' },
      readOnlyTools: new Set(),
    });
    const native = await p24Fixture(
      async (request) => {
        const payload = JSON.stringify(request.messages),
          last = JSON.stringify(latestTaskMessage(request));
        if (!payload.includes('ROOT_PRIVATE')) {
          await (payload.includes('CHILD_A') ? holdA : holdB).promise;
          return { text: 'Synthetic child result' };
        }
        if (last.includes('先停掉 A，B 继续'))
          return {
            nativeTool: {
              name: 'assistant_stop',
              arguments: { childRunId: children[0]!.runId },
            },
          };
        return { text: 'A 已停止，B 继续。' };
      },
      undefined,
      {
        p25: true,
        callback: async (method, p) => {
          const childA = p.nativeSessionId === children[0]?.nativeSessionId;
          // Force the order that used to flake: A's settlement reaches the
          // host after its stop receipt, while the parent's next model call
          // is already waiting on it. B's settlement releases it.
          if (method === 'settled' && childA) await settleA.promise;
          if (method === 'settled' && !childA) settleA.release();
          try {
            const result = await bridge.handle(method, p);
            if (method === 'settled')
              settled.set(String(p.nativeSessionId), 'resolved');
            return result;
          } catch (error) {
            if (method === 'settled')
              settled.set(
                String(p.nativeSessionId),
                `rejected: ${(error as Error).message}`,
              );
            throw error;
          } finally {
            if (method === 'stopped' && childA) stoppedA.release();
          }
        },
      },
    );
    const client = native.launch();
    try {
      await client.call('ready');
      await client.call('create', { id: f.nativeSessionId });
      await client.call('p25/bind', { nativeSessionId: f.nativeSessionId });
      await client.call('prompt', {
        id: f.nativeSessionId,
        text: 'ROOT_PRIVATE',
      });
      await client.call('idle', { id: f.nativeSessionId });
      for (const label of ['A', 'B']) {
        const delegationId = randomUUID();
        const child = await f.delegate({
          delegationId,
          text: `CHILD_${label}`,
        });
        children.push(child.instance);
        await client.call(
          'p25/start',
          await bridge.messageDispatch(delegationId),
        );
      }
      await expect.poll(() => native.requests.length).toBe(3);
      await client.call('prompt', {
        id: f.nativeSessionId,
        text: '先停掉 A，B 继续',
      });
      await stoppedA.promise;
      await expect
        .poll(async () =>
          (await client.snapshot(f.nativeSessionId)).events.some(
            (e) => e.type === 'tool/result',
          ),
        )
        .toBe(true);
      holdB.release();
      await expect
        .poll(
          async () =>
            (await bridge.tree()).results.some(
              (r) =>
                r.runId === children[1]!.runId && r.parentAdoptedSeq !== null,
            ),
          { timeout: 15000 },
        )
        .toBe(true);
      await client.call('idle', { id: f.nativeSessionId });
      expect(settled.get(children[0]!.nativeSessionId)).toBe('resolved');
      const parent = await client.snapshot(f.nativeSessionId);
      const turns = parent.events.filter((e) => e.type === 'turn/end');
      expect(turns.length).toBeGreaterThanOrEqual(2);
      expect(
        turns.map((e) => (e.data.reason as { kind?: string })?.kind),
      ).toEqual(turns.map(() => 'completed'));
      const tree = await bridge.tree();
      expect(
        tree.instances.find((i) => i.runId === children[0]!.runId),
      ).toMatchObject({ status: 'canceled', stoppedAt: expect.any(String) });
      expect(tree.results.map((r) => r.runId)).toEqual([children[1]!.runId]);
    } finally {
      holdA.release();
      holdB.release();
      settleA.release();
      await native.close();
    }
  }, 60000);
  it('SIGKILL cold recovery reads actual JSONL and adopts only known receipts without replaying uncertain work', async () => {
    const f = await assistantFixture(database.db),
      hold = gate();
    const bridge = createAssistantWorkerBridge({
      runtime: f.runtime,
      task: f.task,
      context: f.context,
      worker: f.worker,
      wireNames: { read: 'p24_proposal' },
      readOnlyTools: new Set(),
    });
    const native = await p24Fixture(
      async () => {
        await hold.promise;
        return { text: 'Late uncertain model response' };
      },
      undefined,
      {
        p25: true,
        callback: async (method, params) => {
          // Simulate the durable checkpoint response being lost after native flush;
          // the accepted native MessageId remains known to the platform.
          if (method === 'checkpoint')
            return bridge.handle(method, {
              nativeSessionId: params.nativeSessionId,
              inputId: params.inputId,
              nativeMessageId: params.nativeMessageId,
            });
          return bridge.handle(method, params);
        },
      },
    );
    const client = native.launch();
    try {
      await client.call('ready');
      await client.call('create', { id: f.nativeSessionId });
      await client.call('p25/bind', { nativeSessionId: f.nativeSessionId });
      const delegationId = randomUUID(),
        child = (await f.delegate({ delegationId })).instance;
      await client.call(
        'p25/start',
        await bridge.messageDispatch(delegationId),
      );
      await expect.poll(() => native.requests.length).toBe(1);
      expect((await bridge.tree()).messages[0]?.status).toBe('accepted');
      await client.crash();
      const leaseToken = randomUUID(),
        replacement = { ...f.worker, leaseToken };
      await database.db`update allrice_jobs set lease_token=${leaseToken} where id=${f.worker.jobId}`;
      await f.runtime.quarantineExpired({
        scope: f.task.scope,
        rootRunId: f.task.runId,
      });
      const cold = native.launch();
      await cold.call('ready');
      const inspection = await cold.call('p25/inspect', {
        nativeSessionId: child.nativeSessionId,
      });
      const tree = await bridge.tree(),
        checkpoints = assistantNativeCheckpointEvidence(
          inspection,
          tree.messages,
        );
      expect(checkpoints[0]?.adoptedSeq).toBeTypeOf('number');
      expect(
        await f.runtime.recoverNativeEvidence(f.context, {
          rootRunId: f.task.runId,
          nativeSessionId: child.nativeSessionId,
          worker: replacement,
          checkpoints,
        }),
      ).toMatchObject({ replay: false, recovered: 1 });
      expect((await bridge.tree()).messages[0]?.status).toBe('adopted');
      expect(
        (await bridge.tree()).instances.every((i) => i.status === 'unknown'),
      ).toBe(true);
      expect(native.requests).toHaveLength(1);
      expect(
        (await bridge.tree()).budgets.find((b) => b.metric === 'model_calls')!
          .reserved,
      ).toBe(1);
      await expect(f.delegate({ worker: replacement })).rejects.toThrow(
        'lease_lost',
      );
    } finally {
      hold.release();
      await native.close();
    }
  }, 60000);
});
