import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantWorkerBridge } from '../../src/harness/dsh/assistant-bridge.js';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration(
  'MET-210 child stop completion boundaries (isolated PostgreSQL)',
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

    const fixture = () =>
      assistantFixture(database.db, 12, {
        allowedTools: [
          'read',
          'assistant.delegate',
          'assistant.report',
          'assistant.message',
          'assistant.stop',
        ],
      });
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const bridgeFor = (f: Fixture) =>
      createAssistantWorkerBridge({
        runtime: f.runtime,
        task: f.task,
        context: f.context,
        worker: f.worker,
        wireNames: {},
        readOnlyTools: new Set(),
      });
    const stop = (f: Fixture, childRunId: string) =>
      f.runtime.cancelChild(f.context, {
        runId: f.task.runId,
        childRunId,
        requestId: randomUUID(),
      });
    async function adoptMessage(f: Fixture, inputId: string) {
      await f.runtime.claimMessage({ ...f.base, inputId });
      await f.runtime.checkpointMessage({
        ...f.base,
        inputId,
        nativeMessageId: randomUUID(),
        durableSeq: 1,
        adoptedSeq: 2,
      });
    }
    async function report(f: Fixture, status: 'completed' | 'partial') {
      const delegationId = randomUUID();
      const child = (await f.delegate({ delegationId })).instance;
      await adoptMessage(f, delegationId);
      // Account for the synthetic launch before recording an explicit report.
      await f.runtime.settleUsage({
        ...f.base,
        callId: delegationId,
        amounts: { model_calls: 0 },
      });
      const artifact = await f.artifact(child.runId);
      await f.runtime.registerArtifact({
        ...f.base,
        runId: child.runId,
        relativePath: 'answer.txt',
        ...artifact,
      });
      const deliveryId = randomUUID();
      expect(
        await f.runtime.recordResult({
          ...f.base,
          runId: child.runId,
          result: {
            deliveryId,
            status,
            summary: 'Saved child work',
            evidence: [{ id: artifact.artifactId, digest: artifact.digest }],
            incomplete:
              status === 'partial' ? ['The last chapter is unfinished.'] : [],
            usageComplete: true,
          },
        }),
      ).toMatchObject({ status, wakeParent: true });
      return { child, deliveryId };
    }

    // A stop waives the adoption of a report the parent never took in, but
    // never rewrites what the child reported: partial stays partial.
    it.each(['completed', 'partial'] as const)(
      'retains an unadopted %s report, but only a confirmed stop waives its adoption',
      async (status) => {
        // Separate roots: finalizeRoot records a terminal outcome, so do not reuse
        // an unknown root to simulate a later successful first finalization.
        for (const stage of ['no-stop', 'requested', 'confirmed'] as const) {
          const f = await fixture(),
            { child, deliveryId } = await report(f, status);
          if (stage !== 'no-stop') await stop(f, child.runId);
          if (stage === 'confirmed')
            await f.runtime.confirmStopped({ ...f.base, runId: child.runId });
          const tree = await f.runtime.getTree(f.context, {
            runId: f.task.runId,
          });
          expect(tree.results).toMatchObject([
            { deliveryId, status, parentAdoptedSeq: null },
          ]);
          expect(
            tree.instances.find((i) => i.runId === child.runId),
          ).toMatchObject({
            status,
            stoppedAt: stage === 'confirmed' ? expect.any(String) : null,
          });
          expect(await f.runtime.finalizeRoot(f.base)).toMatchObject({
            status: stage === 'confirmed' ? status : 'unknown',
          });
          expect(
            (await f.runtime.getTree(f.context, { runId: f.task.runId }))
              .results[0],
          ).toMatchObject({
            deliveryId,
            status,
            parentAdoptedSeq: null,
          });
        }
      },
    );

    it.each(['pending', 'dispatching', 'accepted', 'durable'] as const)(
      'unconsumed assistant_message at %s is waived only after A stops',
      async (phase) => {
        const f = await fixture(),
          a = (await f.delegate()).instance;
        let inputId: string = randomUUID();
        if (phase === 'pending')
          await f.runtime.requestMessage(f.context, {
            runId: f.task.runId,
            childRunId: a.runId,
            inputId,
            text: '请把结尾改成开放式。',
          });
        else {
          const dispatched = await bridgeFor(f).handle('message', {
            nativeSessionId: f.nativeSessionId,
            callId: randomUUID(),
            arguments: { childRunId: a.runId, text: '请把结尾改成开放式。' },
          });
          inputId = String(dispatched.inputId);
          if (phase !== 'dispatching')
            await f.runtime.checkpointMessage({
              ...f.base,
              inputId,
              nativeMessageId: randomUUID(),
              ...(phase === 'durable' ? { durableSeq: 3 } : {}),
            });
        }
        expect(
          (
            await f.runtime.getTree(f.context, { runId: f.task.runId })
          ).messages.find((m) => m.inputId === inputId)?.status,
        ).toBe(phase);
        await stop(f, a.runId);
        await f.runtime.confirmStopped({ ...f.base, runId: a.runId });
        await expect(
          f.runtime.claimMessage({ ...f.base, inputId }),
        ).rejects.toThrow('canceled');
        expect(await f.runtime.finalizeRoot(f.base)).toMatchObject({
          status: 'completed',
        });
        const message = (
          await f.runtime.getTree(f.context, { runId: f.task.runId })
        ).messages.find((m) => m.inputId === inputId);
        expect(message).toMatchObject({
          status: phase === 'pending' ? 'canceled' : phase,
          adoptedSeq: null,
        });
      },
    );
  },
);
