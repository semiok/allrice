import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import { assertAssistantAuthority } from './assistant-authority.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration(
  'P27 output reservation layout — root-cause evidence, not a dynamic-grant fix',
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

    async function layout() {
      const f = await createAssistantAuthorityFixture(database.db, {
        configure: false,
        allowedTools: ['assistant.delegate', 'assistant.report'],
      });
      const configuration = { ...f.config, maxConcurrent: 2, maxDepth: 1 };
      // Bootstrap only this fresh, empty fixture. The tested immutable root is
      // created with the observed 12000 cap; no live budget is enlarged or reset.
      await database.db.begin(async (tx) => {
        const admitted = await tx`
        select 1 from allrice_assistant_instances where root_run_id=${f.rootRunId}
        union all select 1 from allrice_assistant_roots where root_run_id=${f.rootRunId}
        union all select 1 from allrice_assistant_usage where root_run_id=${f.rootRunId}
        union all select 1 from allrice_runtime_operations where root_run_id=${f.rootRunId}`;
        expect(admitted).toHaveLength(0);
        await tx`delete from allrice_runtime_budgets where root_run_id=${f.rootRunId}`;
        await tx`delete from allrice_runtime_run_links where root_run_id=${f.rootRunId}`;
        await tx`delete from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
        await tx`update allrice_runs set input=${tx.json({ assistantConfiguration: configuration })} where id=${f.rootRunId}`;
      });
      await f.ledger.createRoot({
        task: f.task,
        deadlineAt: new Date(Date.now() + 300000).toISOString(),
        budgets: (
          [
            { metric: 'model_calls', unit: 'calls', capacity: 16 },
            { metric: 'tool_calls', unit: 'calls', capacity: 64 },
            { metric: 'input_tokens', unit: 'tokens', capacity: 80000 },
            { metric: 'output_tokens', unit: 'tokens', capacity: 12000 },
          ] as const
        ).map((budget) => ({
          ...budget,
          currency: null,
          source: { kind: 'worker' as const, sourceId: 'assistant-v1' },
        })),
      });
      await f.runtime.configureRoot({
        task: f.task,
        configuration,
        nativeSessionId: f.nativeSessionId,
        worker: f.worker,
        allowedTools: ['assistant.delegate', 'assistant.report'],
      });
      const request = (
        runId: string,
        output: number,
        callId = randomUUID(),
      ) => ({
        ...f.base,
        runId,
        callId,
        kind: 'model' as const,
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          input_tokens: 1,
          output_tokens: output,
        },
      });
      const parent = request(f.rootRunId, 4000);
      await f.runtime.reserveUsage(parent);
      await f.runtime.settleUsage({
        ...f.base,
        runId: f.rootRunId,
        callId: parent.callId,
        amounts: { ...parent.amounts, output_tokens: 246 },
      });
      const children = await Promise.all(
        ['first', 'second'].map(async (label) => {
          const { instance } = await f.runtime.provision({
            ...f.base,
            parentRunId: f.rootRunId,
            delegationId: randomUUID(),
            label,
            text: 'Synthetic ledger test; never call a provider.',
            tools: ['assistant.report'],
          });
          const call = request(instance.runId, 4000);
          await f.runtime.reserveUsage(call);
          return call;
        }),
      );
      const tree = () => f.runtime.getTree(f.context, { runId: f.rootRunId });
      const usage = () => database.db`
      select call_id,run_id,metric,amount,settled_amount from allrice_assistant_usage
      where root_run_id=${f.rootRunId} order by call_id,metric`;
      expect(
        (await tree()).budgets.find((b) => b.metric === 'output_tokens'),
      ).toMatchObject({
        capacity: 12000,
        spent: 246,
        reserved: 8000,
        usageComplete: false,
      });
      return { f, children, request, tree, usage };
    }

    it('records output over old capacity and continues without erasing unknown sibling usage', async () => {
      const { f, children, tree, usage } = await layout();
      const child = children[0]!;
      await f.runtime.settleUsage({
        ...f.base,
        runId: child.runId,
        callId: child.callId,
        amounts: { ...child.amounts, output_tokens: 13000 },
      });
      expect((await tree()).cancelRequested).toBe(false);
      expect(
        (await tree()).budgets.find((b) => b.metric === 'output_tokens'),
      ).toMatchObject({ spent: 13246, reserved: 4000, usageComplete: false });
      expect(
        (await usage()).find(
          (r) => r.call_id === child.callId && r.metric === 'output_tokens',
        ),
      ).toMatchObject({ settled_amount: '13000' });
      expect(
        (await usage()).find(
          (r) =>
            r.call_id === children[1]!.callId && r.metric === 'output_tokens',
        ),
      ).toMatchObject({ settled_amount: null });
      await expect(
        f.runtime.prepareModelUsage({
          ...f.base,
          runId: f.rootRunId,
          callId: randomUUID(),
          requestedOutputTokens: 1,
        }),
      ).resolves.toMatchObject({ prepared: true });
    });

    it('admits parent output above the old remainder and preserves child receipts', async () => {
      const { f, request, tree, usage } = await layout();
      const existing = await usage();
      const call = request(f.rootRunId, 4000);
      await expect(f.runtime.reserveUsage(call)).resolves.toEqual({
        reserved: true,
      });
      expect((await usage()).filter((r) => r.call_id !== call.callId)).toEqual(
        existing,
      );
      expect(
        (await tree()).budgets.find((b) => b.metric === 'output_tokens'),
      ).toMatchObject({
        capacity: 12000,
        spent: 246,
        reserved: 12000,
        usageComplete: false,
      });
    });
    it('serializes distinct and duplicate reservations without enforcing old capacity', async () => {
      const { f, request, tree, usage } = await layout();
      const existing = await usage();
      const calls = [request(f.rootRunId, 4000), request(f.rootRunId, 4000)];
      expect(
        await Promise.all(calls.map((call) => f.runtime.reserveUsage(call))),
      ).toEqual([{ reserved: true }, { reserved: true }]);
      const before = { tree: await tree(), usage: await usage() };
      expect(
        before.tree.budgets.find((b) => b.metric === 'output_tokens'),
      ).toMatchObject({
        capacity: 12000,
        spent: 246,
        reserved: 16000,
        usageComplete: false,
      });
      expect(
        before.usage.filter(
          (row) => !calls.some((call) => call.callId === row.call_id),
        ),
      ).toEqual(existing);
      await expect(f.runtime.reserveUsage(calls[0]!)).resolves.toEqual({
        reserved: false,
      });
      await expect(
        f.runtime.reserveUsage({
          ...calls[0]!,
          amounts: { ...calls[0]!.amounts, output_tokens: 3999 },
        }),
      ).rejects.toThrow('conflict');
      expect({ tree: await tree(), usage: await usage() }).toEqual(before);
    });

    it('keeps omitted child output unknown through partial settlement, a fresh service, and cancellation', async () => {
      const { f, children, request, tree, usage } = await layout();
      for (const child of children) {
        await f.runtime.settleUsage({
          ...f.base,
          runId: child.runId,
          callId: child.callId,
          // Known calls/input are settled; missing output is not evidence of zero.
          amounts: { model_calls: 1, tool_calls: 0, input_tokens: 1 },
        });
      }
      const restarted = createAssistantRuntime({
        database: database.db,
        authorize: assertAssistantAuthority,
      });
      await expect(
        restarted.reserveUsage(request(f.rootRunId, 4000)),
      ).resolves.toEqual({ reserved: true });
      const before = { tree: await tree(), usage: await usage() };
      await restarted.cancelRoot(f.context, {
        runId: f.rootRunId,
        requestId: randomUUID(),
      });
      expect((await tree()).budgets).toEqual(before.tree.budgets);
      expect(await usage()).toEqual(before.usage);
      for (const child of children) {
        expect(
          (await usage()).find(
            (row) =>
              row.call_id === child.callId && row.metric === 'output_tokens',
          ),
        ).toMatchObject({
          amount: '4000',
          settled_amount: null,
        });
      }
      expect(
        (await tree()).budgets.find((b) => b.metric === 'output_tokens'),
      ).toMatchObject({
        spent: 246,
        reserved: 12000,
        usageComplete: false,
      });
    });
  },
);
