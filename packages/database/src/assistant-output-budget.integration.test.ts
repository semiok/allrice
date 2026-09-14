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

    it('rejects parent 4000 with only 3754 free and rolls back every dimension without touching child reservations', async () => {
      const { f, request, tree, usage } = await layout();
      const before = { tree: await tree(), usage: await usage() };
      const denied = request(f.rootRunId, 4000);
      await expect(f.runtime.reserveUsage(denied)).rejects.toThrow(
        'budget_exhausted',
      );
      expect({ tree: await tree(), usage: await usage() }).toEqual(before);
      expect(
        (await usage()).filter((row) => row.call_id === denied.callId),
      ).toHaveLength(0);
      expect(
        (await tree()).budgets.every((b) => b.spent + b.reserved <= b.capacity),
      ).toBe(true);
    });

    it('serializes competing exact-remainder requests and rolls back a full-capacity rejection', async () => {
      const { f, request, tree, usage } = await layout();
      const existing = await usage();
      // This is an explicit test input to the CURRENT reservation API, not an
      // automatic grant, changed provider limit, or implemented dynamic policy.
      const calls = [request(f.rootRunId, 3754), request(f.rootRunId, 3754)];
      const results = await Promise.allSettled(
        calls.map((call) => f.runtime.reserveUsage(call)),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const loser = results.findIndex((result) => result.status === 'rejected');
      expect(results[loser]).toMatchObject({
        reason: { code: 'budget_exhausted' },
      });
      expect(
        (await usage()).filter((row) => row.call_id === calls[loser]!.callId),
      ).toHaveLength(0);
      const accepted = calls[1 - loser]!;
      const full = { tree: await tree(), usage: await usage() };
      expect(
        full.tree.budgets.find((b) => b.metric === 'output_tokens'),
      ).toMatchObject({
        capacity: 12000,
        spent: 246,
        reserved: 11754,
        usageComplete: false,
      });
      expect(
        full.usage.filter((row) => row.call_id !== accepted.callId),
      ).toEqual(existing);
      await expect(f.runtime.reserveUsage(accepted)).resolves.toEqual({
        reserved: false,
      });
      await expect(
        f.runtime.reserveUsage({
          ...accepted,
          amounts: { ...accepted.amounts, output_tokens: 3753 },
        }),
      ).rejects.toThrow('conflict');
      await expect(
        f.runtime.reserveUsage(request(f.rootRunId, 1)),
      ).rejects.toThrow('budget_exhausted');
      expect({ tree: await tree(), usage: await usage() }).toEqual(full);
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
      const before = { tree: await tree(), usage: await usage() };
      const restarted = createAssistantRuntime({
        database: database.db,
        authorize: assertAssistantAuthority,
      });
      await expect(
        restarted.reserveUsage(request(f.rootRunId, 4000)),
      ).rejects.toThrow('budget_exhausted');
      expect({ tree: await tree(), usage: await usage() }).toEqual(before);
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
        reserved: 8000,
        usageComplete: false,
      });
    });
  },
);
