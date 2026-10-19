import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration(
  'Undispatched model preparation closure — isolated PostgreSQL',
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

    async function setup() {
      const f = await assistantFixture(database.db);
      const callId = randomUUID();
      const input = { ...f.base, runId: f.task.runId, callId };
      await f.runtime.prepareModelUsage({
        ...input,
        requestedOutputTokens: 4000,
      });
      const dispatch = () =>
        f.runtime.dispatchModelUsage({
          ...input,
          inputTokens: 100,
          outputTokens: 4000,
          requestDigest: `sha256:${'a'.repeat(64)}`,
        });
      const close = () => f.runtime.closeUndispatchedModelPreparation(input);
      const budgets = async () =>
        (await f.runtime.getTree(f.context, { runId: f.task.runId })).budgets;
      const row = async () => {
        const [instance] = await database.db`
      select status,stopped_at,cancel_requested_at from allrice_assistant_instances where run_id=${f.task.runId}`;
        if (!instance) throw new Error('missing assistant instance fixture');
        return instance;
      };
      const admission = async () => {
        const [prepared] = await database.db`
      select dispatched_at,finished_at,request_digest,input_tokens from allrice_assistant_model_admissions where call_id=${callId}`;
        if (!prepared) throw new Error('missing model admission fixture');
        return prepared;
      };
      return { f, input, dispatch, close, budgets, row, admission };
    }

    it('abandons only the unsent call, keeps the Run live, and permits a fresh call without reusing the closed identity', async () => {
      const s = await setup();
      expect(await s.close()).toEqual({
        closed: true,
        callId: s.input.callId,
        alreadyClosed: false,
      });
      const before = await s.budgets();
      expect(before.every((b) => b.reserved === 0)).toBe(true);
      expect(await s.close()).toEqual({
        closed: true,
        callId: s.input.callId,
        alreadyClosed: true,
      });
      expect(await s.budgets()).toEqual(before);
      expect(await s.admission()).toEqual({
        dispatched_at: null,
        finished_at: null,
        request_digest: null,
        input_tokens: null,
      });
      expect(await s.row()).toMatchObject({
        status: 'running',
        stopped_at: null,
        cancel_requested_at: null,
      });
      await expect(s.dispatch()).rejects.toThrow('conflict');
      await s.f.runtime.markNativeIdle({ ...s.f.base, runId: s.f.task.runId });
      expect((await s.row()).status).toBe('waiting');
      const next = { ...s.input, callId: randomUUID() };
      await s.f.runtime.prepareModelUsage({
        ...next,
        requestedOutputTokens: 1000,
      });
      await s.f.runtime.markNativeIdle({ ...s.f.base, runId: s.f.task.runId });
      expect((await s.row()).status).toBe('running');
      await s.f.runtime.dispatchModelUsage({
        ...next,
        inputTokens: 20,
        outputTokens: 1000,
        requestDigest: `sha256:${'b'.repeat(64)}`,
      });
      await s.f.runtime.settleUsage({
        ...next,
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          input_tokens: 20,
          output_tokens: 7,
        },
      });
      await s.f.runtime.markNativeIdle({ ...s.f.base, runId: s.f.task.runId });
      expect((await s.row()).status).toBe('waiting');
      expect(
        (await s.budgets()).find((b) => b.metric === 'model_calls'),
      ).toMatchObject({ reserved: 0, spent: 1 });
    });

    it('preserves a dispatched call and its real accounting, including repeated dispatch acknowledgment', async () => {
      const s = await setup();
      await s.dispatch();
      const before = await s.budgets();
      await expect(s.close()).rejects.toThrow('conflict');
      expect(await s.budgets()).toEqual(before);
      expect(await s.dispatch()).toMatchObject({ reserved: false });
      await s.f.runtime.markNativeIdle({ ...s.f.base, runId: s.f.task.runId });
      expect((await s.row()).status).toBe('running');
      expect((await s.admission()).dispatched_at).not.toBeNull();
    });

    it('requires the exact active scope, run, call, lease, generation, and fence', async () => {
      const s = await setup();
      const other = await assistantFixture(database.db);
      const before = await s.budgets();
      const invalid = [
        { ...s.input, scope: other.task.scope },
        { ...s.input, runId: other.task.runId },
        { ...s.input, callId: randomUUID() },
        ...[
          { ...s.f.worker, leaseToken: randomUUID() },
          { ...s.f.worker, generation: s.f.worker.generation + 1 },
          // The fixture's initial root fence is 1; this is an unissued fence.
          { ...s.f.worker, fence: 2 },
        ].map((worker) => ({ ...s.input, worker })),
      ];
      for (const input of invalid) {
        await expect(
          s.f.runtime.closeUndispatchedModelPreparation(input),
        ).rejects.toThrow();
        expect(await s.budgets()).toEqual(before);
      }
      await s.f.runtime.cancelRoot(s.f.context, {
        runId: s.f.task.runId,
        requestId: randomUUID(),
      });
      await expect(s.close()).rejects.toThrow('canceled');
      expect(await s.budgets()).toEqual(before);
    });

    it.each([false, true])(
      'cancel keeps exact close forbidden; confirmed native stop releases only unsent calls (dispatched=%s)',
      async (dispatched) => {
        const s = await setup();
        if (dispatched) await s.dispatch();
        const before = await s.budgets();
        await s.f.runtime.cancelRoot(s.f.context, {
          runId: s.f.task.runId,
          requestId: randomUUID(),
        });
        await expect(s.close()).rejects.toThrow('canceled');
        expect(await s.budgets()).toEqual(before);
        await s.f.runtime.confirmStopped({
          ...s.f.base,
          runId: s.f.task.runId,
        });
        const after = await s.budgets();
        if (dispatched) expect(after).toEqual(before);
        else
          expect(after.every((b) => b.reserved === 0 && b.spent === 0)).toBe(
            true,
          );
        expect((await s.admission()).dispatched_at !== null).toBe(dispatched);
        expect((await s.admission()).finished_at).toBeNull();
        await s.f.runtime.confirmStopped({
          ...s.f.base,
          runId: s.f.task.runId,
        });
        expect(await s.budgets()).toEqual(after);
        expect((await s.row()).status).toBe('canceled');
      },
    );

    it.each(['close', 'dispatch', 'concurrent'] as const)(
      'serializes %s admission order without double release or post-close dispatch',
      async (first) => {
        const s = await setup();
        if (first === 'close') await s.close();
        if (first === 'dispatch') await s.dispatch();
        const [closed, dispatched] = await Promise.allSettled([
          s.close(),
          s.dispatch(),
        ]);
        expect(
          [closed, dispatched].filter((r) => r.status === 'fulfilled'),
        ).toHaveLength(1);
        const wasDispatched = (await s.admission()).dispatched_at !== null;
        expect(wasDispatched).toBe(dispatched.status === 'fulfilled');
        const before = await s.budgets();
        if (wasDispatched) {
          await expect(s.close()).rejects.toThrow('conflict');
          expect(before.find((b) => b.metric === 'model_calls')).toMatchObject({
            reserved: 1,
          });
        } else {
          await expect(s.dispatch()).rejects.toThrow('conflict');
          await s.close();
          expect(before.every((b) => b.reserved === 0)).toBe(true);
        }
        expect(await s.budgets()).toEqual(before);
      },
    );

    it('never treats missing or partially settled preparation evidence as a safely closed model call', async () => {
      for (const malformed of ['missing', 'partial'] as const) {
        const s = await setup();
        if (malformed === 'missing')
          await database.db`delete from allrice_assistant_usage where call_id=${s.input.callId} and metric='input_tokens'`;
        else
          await database.db`update allrice_assistant_usage set settled_amount=0 where call_id=${s.input.callId} and metric='input_tokens'`;
        const before = await s.budgets();
        await expect(s.close()).rejects.toThrow('conflict');
        expect(await s.budgets()).toEqual(before);
        await s.f.runtime.markNativeIdle({
          ...s.f.base,
          runId: s.f.task.runId,
        });
        expect((await s.row()).status).toBe('running');
      }
    });
  },
);
