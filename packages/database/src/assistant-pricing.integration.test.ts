import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  selectAssistantPriceSnapshot,
  type AssistantPriceCatalog,
} from '@allrice/contracts';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { createAssistantPricing } from './assistant-pricing.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'assistant pricing evidence — real isolated PG, fictional rates, no provider',
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
      const pricing = createAssistantPricing({ database: database.db });
      const target = {
        connectionId: randomUUID(),
        catalogId: randomUUID(),
        harness: 'dsh' as const,
        provider: 'gemini',
        authMode: 'api_key' as const,
        model: 'synthetic-only',
        baseUrl: 'https://billing-fixture.example.test/v1',
        serviceTier: 'standard',
        modality: 'text' as const,
      };
      const now = Date.now();
      const catalog: AssistantPriceCatalog = {
        version: 1,
        catalogVersion: 'synthetic-only',
        entries: [
          {
            id: 'synthetic-price',
            target,
            billingMode: 'token_metered',
            currency: 'USD',
            effectiveAt: new Date(now - 60000).toISOString(),
            expiresAt: new Date(now + 3600000).toISOString(),
            maxInputTokens: 100000,
            maxOutputTokens: 100000,
            rates: {
              uncachedInputMicrounitsPerMillion: '2000000',
              cacheReadMicrounitsPerMillion: '500000',
              cacheWriteMicrounitsPerMillion: '3000000',
              outputMicrounitsPerMillion: '8000000',
            },
            source: {
              reference: 'synthetic-only-no-real-prices',
              digest: `sha256:${'a'.repeat(64)}`,
            },
          },
        ],
      };
      const snapshot = selectAssistantPriceSnapshot({
        catalog,
        target,
        currency: 'USD',
        at: new Date(now).toISOString(),
      });
      const frozen = await pricing.freeze({ ...f.base, snapshot });
      const call = async (runId: string = f.task.runId, complete = true) => {
        const callId = randomUUID(),
          requestDigest = `sha256:${'b'.repeat(64)}`;
        await f.runtime.prepareModelUsage({
          ...f.base,
          runId,
          callId,
          requestedOutputTokens: 100,
        });
        await f.runtime.dispatchModelUsage({
          ...f.base,
          runId,
          callId,
          inputTokens: 1000,
          outputTokens: 100,
          requestDigest,
        });
        await f.runtime.settleUsage({
          ...f.base,
          runId,
          callId,
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 100,
            ...(complete ? { output_tokens: 30 } : {}),
          },
        });
        return {
          ...f.base,
          runId,
          callId,
          requestDigest,
          snapshotDigest: frozen.snapshotDigest,
          usage: {
            inputTokens: 100,
            outputTokens: complete ? 30 : null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            usageComplete: complete,
          },
        };
      };
      return { f, pricing, snapshot, frozen, call };
    };
    it('freezes before admission; exact concurrent replay is idempotent and repricing is refused', async () => {
      const { f, pricing, snapshot, frozen, call } = await setup();
      expect(await pricing.freeze({ ...f.base, snapshot })).toEqual({
        frozen: false,
        snapshotDigest: frozen.snapshotDigest,
      });
      const changed = structuredClone(snapshot);
      changed.price.rates.outputMicrounitsPerMillion = '9000000';
      await expect(
        pricing.freeze({ ...f.base, snapshot: changed }),
      ).rejects.toThrow('SNAPSHOT_CONFLICT');
      await call();
      expect(await pricing.freeze({ ...f.base, snapshot })).toMatchObject({
        frozen: false,
      });
      const [row] =
        await database.db`select count(*)::int as count from allrice_assistant_price_snapshots where root_run_id=${f.task.rootRunId}`;
      expect(row!.count).toBe(1);
    });
    it('cannot retrospectively price a root that already admitted a model call', async () => {
      const { snapshot } = await setup();
      const other = await assistantFixture(database.db);
      await other.runtime.prepareModelUsage({
        ...other.base,
        runId: other.task.runId,
        callId: randomUUID(),
        requestedOutputTokens: 100,
      });
      await expect(
        createAssistantPricing({ database: database.db }).freeze({
          ...other.base,
          snapshot,
        }),
      ).rejects.toThrow('FREEZE_TOO_LATE');
      const rows =
        await database.db`select 1 from allrice_assistant_price_snapshots where root_run_id=${other.task.rootRunId}`;
      expect(rows).toHaveLength(0);
    });
    it('stores an immutable conservative estimate, NOT actual cost or known cache; concurrent duplicate charges once', async () => {
      const { f, pricing, call } = await setup();
      const input = await call();
      const outcomes = await Promise.all([
        pricing.recordUsage(input),
        pricing.recordUsage(input),
      ]);
      expect(outcomes.map((value) => value.recorded).sort()).toEqual([
        false,
        true,
      ]);
      expect(outcomes[0]).toMatchObject({
        costPicounits: '540000000',
        costCentsDecimal: '0.054000',
        costBasis: 'conservative_upper_bound',
        actualCostKnown: false,
        cacheUsageKnown: false,
      });
      const [row] =
        await database.db`select * from allrice_assistant_cost_receipts where call_id=${input.callId}`;
      expect(row).toMatchObject({
        root_run_id: f.task.rootRunId,
        run_id: f.task.runId,
        usage_complete: true,
        cache_usage_known: false,
        actual_cost_known: false,
        cost_basis: 'conservative_upper_bound',
        cost_picounits: '540000000',
      });
      expect(await pricing.summarize(f.base)).toMatchObject({
        callCount: 1,
        usageComplete: true,
        cacheUsageKnown: false,
        costCentsDecimal: '0.054000',
        actualCostKnown: false,
      });
    });
    it('aggregates root and two child self-only receipts once with no parent-adoption charge', async () => {
      const { f, pricing, call } = await setup();
      const children = await Promise.all([f.delegate(), f.delegate()]);
      const calls = [
        await call(),
        ...(await Promise.all(
          children.map((child) => call(child.instance.runId)),
        )),
      ];
      for (const input of calls) await pricing.recordUsage(input);
      expect(await pricing.summarize(f.base)).toMatchObject({
        callCount: 3,
        usageComplete: true,
        costPicounits: '1620000000',
        costCentsDecimal: '0.162000',
        cacheUsageKnown: false,
      });
      for (const input of calls) await pricing.recordUsage(input);
      expect((await pricing.summarize(f.base)).costPicounits).toBe(
        '1620000000',
      );
    });
    it('requires exact admission digest, snapshot, child identity and confirmed totals', async () => {
      const { f, pricing, call } = await setup();
      const input = await call();
      const child = await f.delegate();
      await expect(
        pricing.recordUsage({
          ...input,
          requestDigest: `sha256:${'c'.repeat(64)}`,
        }),
      ).rejects.toThrow('CALL_CONFLICT');
      await expect(
        pricing.recordUsage({
          ...input,
          snapshotDigest: `sha256:${'c'.repeat(64)}`,
        }),
      ).rejects.toThrow('SNAPSHOT_CONFLICT');
      await expect(
        pricing.recordUsage({ ...input, runId: child.instance.runId }),
      ).rejects.toThrow('CALL_CONFLICT');
      for (const field of ['inputTokens', 'outputTokens'] as const)
        await expect(
          pricing.recordUsage({
            ...input,
            usage: { ...input.usage, [field]: 1 },
          }),
        ).rejects.toThrow('USAGE_UNCONFIRMED');
      await expect(
        pricing.recordUsage({
          ...input,
          usage: { ...input.usage, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      ).rejects.toThrow('CACHE_UNCONFIRMED');
      expect(
        await database.db`select 1 from allrice_assistant_cost_receipts where call_id=${input.callId}`,
      ).toHaveLength(0);
    });
    it('does not accept expired/replaced leases, scopes or another tenant call', async () => {
      const { f, pricing, call } = await setup();
      const input = await call();
      const other = await assistantFixture(database.db);
      await expect(
        pricing.recordUsage({ ...input, scope: other.task.scope }),
      ).rejects.toThrow('SCOPE_DENIED');
      await expect(
        pricing.recordUsage({
          ...input,
          worker: { ...input.worker, leaseToken: randomUUID() },
        }),
      ).rejects.toThrow('LEASE_LOST');
      await expect(
        pricing.recordUsage({
          ...input,
          worker: { ...input.worker, generation: input.worker.generation + 1 },
        }),
      ).rejects.toThrow('LEASE_LOST');
      await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
      await expect(pricing.recordUsage(input)).rejects.toThrow('LEASE_LOST');
      await expect(pricing.summarize(f.base)).rejects.toThrow('LEASE_LOST');
    });
    it('never drops an unknown output or upgrades an immutable partial receipt', async () => {
      const { f, pricing, call } = await setup();
      const input = await call(f.task.runId, false);
      expect(await pricing.recordUsage(input)).toMatchObject({
        costBasis: 'unknown',
        costPicounits: null,
        actualCostKnown: false,
      });
      expect(await pricing.summarize(f.base)).toMatchObject({
        usageComplete: false,
        costPicounits: null,
      });
      await f.runtime.settleUsage({
        ...f.base,
        runId: input.runId,
        callId: input.callId,
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          input_tokens: 100,
          output_tokens: 30,
        },
      });
      await expect(
        pricing.recordUsage({
          ...input,
          usage: { ...input.usage, outputTokens: 30, usageComplete: true },
        }),
      ).rejects.toThrow('RECEIPT_CONFLICT');
      const [row] =
        await database.db`select cost_picounits,usage_complete from allrice_assistant_cost_receipts where call_id=${input.callId}`;
      expect(row).toMatchObject({
        cost_picounits: null,
        usage_complete: false,
      });
      expect((await pricing.summarize(f.base)).costPicounits).toBeNull();
    });
    it('settles already-confirmed usage after cancellation/flag OFF without authorizing new work', async () => {
      const { f, pricing, call } = await setup();
      const input = await call();
      await database.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${f.worker.jobId}`;
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      try {
        expect(await pricing.recordUsage(input)).toMatchObject({
          recorded: true,
          costBasis: 'conservative_upper_bound',
        });
        expect((await pricing.summarize(f.base)).costCentsDecimal).toBe(
          '0.054000',
        );
      } finally {
        vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      }
    });
    it('missing receipts and prepared-but-undispatched work never become a known zero estimate', async () => {
      const { f, pricing, call } = await setup();
      await call();
      expect(await pricing.summarize(f.base)).toMatchObject({
        callCount: 1,
        usageComplete: false,
        costPicounits: null,
      });
      const callId = randomUUID();
      await f.runtime.prepareModelUsage({
        ...f.base,
        runId: f.task.runId,
        callId,
        requestedOutputTokens: 100,
      });
      await expect(
        pricing.recordUsage({
          ...f.base,
          runId: f.task.runId,
          callId,
          requestDigest: `sha256:${'b'.repeat(64)}`,
          snapshotDigest: (await pricing.summarize(f.base)).snapshotDigest,
          usage: {
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            usageComplete: false,
          },
        }),
      ).rejects.toThrow('CALL_CONFLICT');
      expect(await pricing.summarize(f.base)).toMatchObject({
        callCount: 2,
        usageComplete: false,
        costPicounits: null,
      });
    });
    it('does not reprice existing route/organization accounting or add a currency budget', async () => {
      const { f, pricing, call } = await setup();
      await pricing.recordUsage(await call());
      expect(
        await database.db`select 1 from allrice_model_usage_ledger where organization_id=${f.task.scope.organizationId}`,
      ).toHaveLength(0);
      expect(
        await database.db`select 1 from allrice_route_decisions where run_id=${f.task.runId}`,
      ).toHaveLength(0);
      expect(
        await database.db`select 1 from allrice_runtime_budgets where root_run_id=${f.task.runId} and metric='cost'`,
      ).toHaveLength(0);
    });
    it('database row triggers reject rewriting/deleting a frozen price or cost receipt', async () => {
      const { f, pricing, call } = await setup();
      const input = await call();
      await pricing.recordUsage(input);
      await expect(
        database.db`update allrice_assistant_price_snapshots set currency='CNY' where root_run_id=${f.task.runId}`,
      ).rejects.toThrow('ASSISTANT_PRICING_IMMUTABLE');
      await expect(
        database.db`delete from allrice_assistant_price_snapshots where root_run_id=${f.task.runId}`,
      ).rejects.toThrow('ASSISTANT_PRICING_IMMUTABLE');
      await expect(
        database.db`update allrice_assistant_cost_receipts set cost_picounits=0 where call_id=${input.callId}`,
      ).rejects.toThrow('ASSISTANT_PRICING_IMMUTABLE');
      await expect(
        database.db`delete from allrice_assistant_cost_receipts where call_id=${input.callId}`,
      ).rejects.toThrow('ASSISTANT_PRICING_IMMUTABLE');
      expect((await pricing.summarize(f.base)).costCentsDecimal).toBe(
        '0.054000',
      );
    });
  },
);
