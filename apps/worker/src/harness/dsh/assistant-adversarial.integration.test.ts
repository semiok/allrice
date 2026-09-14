/** Independent P25 adversarial review. Real isolated PostgreSQL / native DSH;
 * synthetic model responses are NOT real-model or GA acceptance evidence. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type AssistantResult } from '@allrice/contracts';
import { createAssistantRuntime } from '../../../../../packages/database/src/assistant-runtime.ts';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from '../../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantWorkerBridge } from './assistant-bridge.js';
import { gate, p24Fixture } from '../../../test/p24/fixture.js';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const partial = (): AssistantResult => ({
  deliveryId: randomUUID(),
  status: 'partial',
  summary: 'Synthetic incomplete result',
  evidence: [],
  incomplete: ['Synthetic unfinished work'],
  usageComplete: false,
});
integration(
  'P25 independent adversarial ownership, terminal and budget invariants',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });

    it('rejects invented artifact identity/digest rather than minting completed evidence', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      await expect(
        f.runtime.registerArtifact({
          ...f.base,
          runId: child.runId,
          relativePath: 'invented.txt',
          artifactId: randomUUID(),
          digest: `sha256:${'f'.repeat(64)}`,
        }),
      ).rejects.toThrow();
    });

    it('keeps child-canceled late evidence without granting parent wake', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      await f.runtime.cancelChild(f.context, {
        runId: f.task.runId,
        childRunId: child.runId,
        requestId: randomUUID(),
      });
      expect(
        await f.runtime.recordResult({
          ...f.base,
          runId: child.runId,
          result: partial(),
        }),
      ).toMatchObject({ wakeParent: false });
    });

    it('does not rewrite a terminal child Run via a fresh delivery ID', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      await f.runtime.recordResult({
        ...f.base,
        runId: child.runId,
        result: { ...partial(), status: 'failed' },
      });
      try {
        await f.runtime.recordResult({
          ...f.base,
          runId: child.runId,
          result: { ...partial(), status: 'canceled' },
        });
      } catch {
        /* Rejecting the conflicting new delivery is acceptable. */
      }
      const [run] =
        await database.db`select state from allrice_runs where id=${child.runId}`;
      expect(run!.state).toBe('failed');
      expect(
        (
          await f.runtime.getTree(f.context, { runId: f.task.runId })
        ).instances.find((row) => row.runId === child.runId)?.status,
      ).toBe('failed');
    });

    it('cannot omit an exhausted token dimension to admit a model call', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      await database.db`update allrice_runtime_budgets set capacity=0 where root_run_id=${f.task.runId} and metric='input_tokens'`;
      await expect(
        f.runtime.reserveUsage({
          ...f.base,
          runId: child.runId,
          kind: 'model',
          callId: randomUUID(),
          amounts: { model_calls: 1 },
        }),
      ).rejects.toThrow();
    });

    it('budget overrun produces the same instance tombstones as explicit root cancellation', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance,
        callId = randomUUID();
      await f.runtime.reserveUsage({
        ...f.base,
        runId: child.runId,
        kind: 'model',
        callId,
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          input_tokens: 1,
          output_tokens: 1,
        },
      });
      await f.runtime.settleUsage({
        ...f.base,
        callId,
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          input_tokens: 100001,
          output_tokens: 1,
        },
      });
      const tree = await f.runtime.getTree(f.context, { runId: f.task.runId });
      expect(tree.cancelRequested).toBe(true);
      expect(
        tree.instances.every((row) => row.cancelRequestedAt !== null),
      ).toBe(true);
    });

    it('rechecks the Worker lease after a slow authority decision and before reservation commit', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      const runtime = createAssistantRuntime({
        database: database.db,
        authorize: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1100));
        },
      });
      await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '700 milliseconds' where id=${f.worker.jobId}`;
      await expect(
        runtime.reserveUsage({
          ...f.base,
          runId: child.runId,
          kind: 'model',
          callId: randomUUID(),
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 1,
            output_tokens: 1,
          },
        }),
      ).rejects.toThrow('lease_lost');
    });

    it('rejects conflicting durable/adoption sequence observations for the same native message', async () => {
      const f = await assistantFixture(database.db),
        inputId = randomUUID(),
        nativeMessageId = randomUUID();
      await f.delegate({ delegationId: inputId });
      await f.runtime.claimMessage({ ...f.base, inputId });
      await f.runtime.checkpointMessage({
        ...f.base,
        inputId,
        nativeMessageId,
        durableSeq: 3,
        adoptedSeq: 4,
      });
      await expect(
        f.runtime.checkpointMessage({
          ...f.base,
          inputId,
          nativeMessageId,
          durableSeq: 99,
          adoptedSeq: 100,
        }),
      ).rejects.toThrow('conflict');
    });

    it('rejects an empty native adoption identity rather than allowing a later overwrite', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance,
        result = partial();
      await f.runtime.recordResult({ ...f.base, runId: child.runId, result });
      await expect(
        f.runtime.adoptResult({
          ...f.base,
          parentRunId: f.task.runId,
          deliveryId: result.deliveryId,
          nativeMessageId: '',
          adoptedSeq: 2,
        }),
      ).rejects.toThrow();
    });

    it('the existing StopRun job tombstone blocks new assistant calls before heartbeat propagation', async () => {
      const f = await assistantFixture(database.db),
        child = (await f.delegate()).instance;
      await database.db`update allrice_jobs set cancel_requested_at=clock_timestamp(),cancel_reason='Synthetic user stop' where id=${f.worker.jobId}`;
      await expect(
        f.runtime.reserveUsage({
          ...f.base,
          runId: child.runId,
          kind: 'model',
          callId: randomUUID(),
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 1,
            output_tokens: 1,
          },
        }),
      ).rejects.toThrow();
    });

    it('a native sibling identity cannot checkpoint another child input', async () => {
      const f = await assistantFixture(database.db),
        first = (await f.delegate()).instance,
        secondInputId = randomUUID();
      await f.delegate({ delegationId: secondInputId });
      await f.runtime.claimMessage({ ...f.base, inputId: secondInputId });
      const bridge = createAssistantWorkerBridge({
        runtime: f.runtime,
        task: f.task,
        context: f.context,
        worker: f.worker,
        wireNames: {},
        readOnlyTools: new Set(),
      });
      await expect(
        bridge.handle('checkpoint', {
          nativeSessionId: first.nativeSessionId,
          inputId: secondInputId,
          nativeMessageId: randomUUID(),
          durableSeq: 1,
          adoptedSeq: 2,
        }),
      ).rejects.toThrow();
      expect(
        (await bridge.tree()).messages.find(
          (message) => message.inputId === secondInputId,
        )?.status,
      ).toBe('dispatching');
    });

    it('actual over-budget native stream drains the root tree and prevents a late model wake', async () => {
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
          return {
            text: 'Late synthetic response must not wake another model turn.',
          };
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
        const inputId = randomUUID();
        await f.delegate({ delegationId: inputId });
        await client.call('p25/start', await bridge.messageDispatch(inputId));
        await expect.poll(() => native.requests.length).toBe(1);
        // Independent already-completed metered call discovers a real overrun
        // while the native child has an in-flight HTTP/model stream.
        const callId = randomUUID();
        await f.runtime.reserveUsage({
          ...f.base,
          runId: f.task.runId,
          kind: 'model',
          callId,
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 1,
            output_tokens: 1,
          },
        });
        await f.runtime.settleUsage({
          ...f.base,
          callId,
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 100001,
            output_tokens: 1,
          },
        });
        const cancellation = await bridge.cancellation();
        expect(cancellation.instances.length).toBeGreaterThan(0);
        await client.call('p25/drain', cancellation);
        hold.release();
        await client.call('p25/flush');
        expect(native.requests).toHaveLength(1);
        expect(
          (await bridge.tree()).instances.every(
            (row) => row.status === 'canceled' && row.stoppedAt !== null,
          ),
        ).toBe(true);
      } finally {
        hold.release();
        await native.close();
      }
    }, 60000);
  },
);
