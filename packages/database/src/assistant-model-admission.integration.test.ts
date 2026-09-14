import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'P25 two-phase model output grants — isolated real PostgreSQL',
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
    const setup = async () => {
      const f = await assistantFixture(database.db);
      await database.db`update allrice_runtime_budgets set capacity=12000 where root_run_id=${f.task.rootRunId} and metric='output_tokens'`;
      const prepare = (
        runId: string = f.task.runId,
        outputTokens = 4000,
        callId: string = randomUUID(),
      ) => {
        const input = {
          ...f.base,
          runId,
          requestedOutputTokens: outputTokens,
          callId,
        };
        return { input, prepare: () => f.runtime.prepareModelUsage(input) };
      };
      const dispatch = (
        call: ReturnType<typeof prepare>,
        outputTokens: number,
        inputTokens = 100,
      ) =>
        f.runtime.dispatchModelUsage({
          ...f.base,
          runId: call.input.runId,
          callId: call.input.callId,
          inputTokens,
          outputTokens,
          requestDigest: `sha256:${'a'.repeat(64)}`,
        });
      const initial = prepare();
      await initial.prepare();
      await dispatch(initial, 4000);
      await f.runtime.settleUsage({
        ...f.base,
        runId: f.task.runId,
        callId: initial.input.callId,
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          input_tokens: 20,
          output_tokens: 246,
        },
      });
      const children = await Promise.all([f.delegate(), f.delegate()]);
      const pending = children.map((child) => prepare(child.instance.runId));
      for (const child of pending) {
        await child.prepare();
        await dispatch(child, 4000);
      }
      return { f, prepare, dispatch, pending };
    };
    it('grants exactly 3754 under the root lock, freezes identity, and permits dispatch only once', async () => {
      const { f, prepare, dispatch } = await setup();
      const call = prepare();
      await expect(call.prepare()).resolves.toEqual({
        prepared: true,
        outputTokens: 3754,
      });
      await expect(call.prepare()).resolves.toEqual({
        prepared: false,
        outputTokens: 3754,
      });
      await expect(
        f.runtime.prepareModelUsage({
          ...call.input,
          requestedOutputTokens: 3999,
        }),
      ).rejects.toThrow('conflict');
      await expect(dispatch(call, 4000)).rejects.toThrow('conflict');
      await expect(dispatch(call, 3754)).resolves.toEqual({
        reserved: true,
        outputTokens: 3754,
      });
      await expect(dispatch(call, 3754)).resolves.toEqual({
        reserved: false,
        outputTokens: 3754,
      });
      await expect(dispatch(call, 3754, 101)).rejects.toThrow('conflict');
      const [row] =
        await database.db`select * from allrice_assistant_model_admissions where call_id=${call.input.callId}`;
      expect(Number(row!.requested_output_tokens)).toBe(4000);
      expect(Number(row!.granted_output_tokens)).toBe(3754);
      expect(row!.dispatched_at).not.toBeNull();
      const budget = (
        await f.runtime.getTree(f.context, { runId: f.task.runId })
      ).budgets.find((b) => b.metric === 'output_tokens')!;
      expect(budget).toMatchObject({
        capacity: 12000,
        spent: 246,
        reserved: 11754,
      });
    });
    it('concurrent preparations cannot overgrant and full-budget rejection rolls back every dimension', async () => {
      const { f, prepare } = await setup();
      const outcomes = await Promise.allSettled([
        prepare().prepare(),
        prepare().prepare(),
      ]);
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const success = outcomes.find((r) => r.status === 'fulfilled');
      expect(success).toMatchObject({
        value: { prepared: true, outputTokens: 3754 },
      });
      const before = await f.runtime.getTree(f.context, {
        runId: f.task.runId,
      });
      await expect(prepare().prepare()).rejects.toThrow('budget_exhausted');
      expect(
        await f.runtime.getTree(f.context, { runId: f.task.runId }),
      ).toEqual(before);
    });
    it('concurrent same-call preparation and dispatch each admit exactly once; changed frozen request never replays', async () => {
      const { f, prepare, dispatch } = await setup();
      const call = prepare();
      const preparations = await Promise.all([call.prepare(), call.prepare()]);
      expect(preparations.map((r) => r.prepared).sort()).toEqual([false, true]);
      expect(preparations.every((r) => r.outputTokens === 3754)).toBe(true);
      const dispatches = await Promise.all([
        dispatch(call, 3754),
        dispatch(call, 3754),
      ]);
      expect(dispatches.map((r) => r.reserved).sort()).toEqual([false, true]);
      const before = await f.runtime.getTree(f.context, {
        runId: f.task.runId,
      });
      await expect(
        f.runtime.dispatchModelUsage({
          ...f.base,
          runId: f.task.runId,
          callId: call.input.callId,
          inputTokens: 100,
          outputTokens: 3754,
          requestDigest: `sha256:${'b'.repeat(64)}`,
        }),
      ).rejects.toThrow('conflict');
      expect(
        await f.runtime.getTree(f.context, { runId: f.task.runId }),
      ).toEqual(before);
      await f.runtime.settleUsage({
        ...f.base,
        runId: f.task.runId,
        callId: call.input.callId,
        amounts: { model_calls: 1, tool_calls: 0, input_tokens: 20 },
      });
      const [row] =
        await database.db`select finished_at from allrice_assistant_model_admissions where call_id=${call.input.callId}`;
      expect(row!.finished_at).not.toBeNull();
      expect(
        (
          await f.runtime.getTree(f.context, { runId: f.task.runId })
        ).budgets.find((b) => b.metric === 'output_tokens'),
      ).toMatchObject({ reserved: 11754, usageComplete: false });
      await expect(dispatch(call, 3754)).resolves.toEqual({
        reserved: false,
        outputTokens: 3754,
      });
    });
    it('binds both phases to the exact child, scope, generation, fence and original worker incarnation', async () => {
      const { f, prepare, pending } = await setup();
      const call = prepare();
      await call.prepare();
      const dispatch = {
        ...f.base,
        runId: f.task.runId,
        callId: call.input.callId,
        inputTokens: 100,
        outputTokens: 3754,
        requestDigest: `sha256:${'a'.repeat(64)}`,
      };
      const before = await f.runtime.getTree(f.context, {
        runId: f.task.runId,
      });
      await expect(
        f.runtime.dispatchModelUsage({
          ...dispatch,
          runId: pending[0]!.input.runId,
        }),
      ).rejects.toThrow('conflict');
      for (const worker of [
        { ...f.worker, generation: 2 },
        { ...f.worker, fence: 2 },
        { ...f.worker, leaseToken: randomUUID() },
      ]) {
        await expect(
          f.runtime.prepareModelUsage({
            ...call.input,
            callId: randomUUID(),
            worker,
          }),
        ).rejects.toThrow('lease_lost');
        await expect(
          f.runtime.dispatchModelUsage({ ...dispatch, worker }),
        ).rejects.toThrow('lease_lost');
      }
      await expect(
        f.runtime.dispatchModelUsage({
          ...dispatch,
          scope: { ...f.base.scope, workspaceId: randomUUID() },
        }),
      ).rejects.toThrow('not_found');
      const replacement = { ...f.worker, leaseToken: randomUUID() };
      await database.db`update allrice_jobs set lease_token=${replacement.leaseToken} where id=${f.worker.jobId}`;
      for (const worker of [f.worker, replacement]) {
        await expect(
          f.runtime.prepareModelUsage({
            ...call.input,
            callId: randomUUID(),
            worker,
          }),
        ).rejects.toThrow('lease_lost');
        await expect(
          f.runtime.dispatchModelUsage({ ...dispatch, worker }),
        ).rejects.toThrow('lease_lost');
      }
      expect(
        await f.runtime.getTree(f.context, { runId: f.task.runId }),
      ).toEqual(before);
    });
    it('input failure, revocation, cancellation and a fresh reader never release preparation as known zero', async () => {
      const { f, prepare, dispatch } = await setup();
      const call = prepare();
      await call.prepare();
      const before = await f.runtime.getTree(f.context, {
        runId: f.task.runId,
      });
      await expect(
        dispatch(call, 3754, Number.MAX_SAFE_INTEGER),
      ).rejects.toThrow('budget_exhausted');
      expect(
        await f.runtime.getTree(f.context, { runId: f.task.runId }),
      ).toEqual(before);
      await expect(
        f.runtime.settleUsage({
          ...f.base,
          callId: call.input.callId,
          runId: f.task.runId,
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        }),
      ).rejects.toThrow('conflict');
      f.revoke();
      await expect(dispatch(call, 3754)).rejects.toThrow('revoked');
      await f.runtime.cancelRoot(f.context, {
        runId: f.task.runId,
        requestId: randomUUID(),
      });
      await expect(dispatch(call, 3754)).rejects.toThrow();
      const [row] =
        await database.db`select dispatched_at,finished_at from allrice_assistant_model_admissions where call_id=${call.input.callId}`;
      expect(row).toMatchObject({ dispatched_at: null, finished_at: null });
      const after = await createAssistantRuntime({
        database: database.db,
      }).getTree(f.context, { runId: f.task.runId });
      expect(after.budgets).toEqual(before.budgets);
      expect(
        after.budgets.find((b) => b.metric === 'output_tokens')!.usageComplete,
      ).toBe(false);
    });
  },
);
