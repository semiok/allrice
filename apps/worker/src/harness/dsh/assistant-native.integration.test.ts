import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from '../../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantWorkerBridge } from './assistant-bridge.js';
import { p24Fixture, gate } from '../../../test/p24/fixture.js';
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
  it('native parent delegates two independent tasks; model reservations, child Run identities and durable result adoption survive queries', async () => {
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
});
