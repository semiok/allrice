import { randomUUID } from 'node:crypto';
import type { AssistantInstanceView } from '@allrice/contracts';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantWorkerBridge } from '../../src/harness/dsh/assistant-bridge.js';
import { assistantNativeCheckpointEvidence } from '../../src/harness/dsh/assistant-recovery.js';
import { p24Fixture, gate } from '../p24/fixture.js';
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('P25 actual native DSH + PostgreSQL governed adapter', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    process.env.ALLRICE_ASSISTANTS_ENABLED = '1';
    database = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    delete process.env.ALLRICE_ASSISTANTS_ENABLED;
    await database?.close();
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
          last = request.messages.at(-1);
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
      200,
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
      200,
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
      200,
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
      200,
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
