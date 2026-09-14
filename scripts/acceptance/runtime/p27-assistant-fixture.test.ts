import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_DATABASE_URL,
  RUN_LIMITS,
  selectedProvider,
} from './p27-assistant-preflight.ts';
import {
  verifyP27PricingReceipts,
  type P27CostReceipt,
  type P27PricedAdmission,
} from './p27-assistant-pricing.ts';
import { randomUUID } from 'node:crypto';

const integration =
  process.env.ALLRICE_RUN_P27_FIXTURE_TEST === '1' ? describe : describe.skip;
integration(
  'P27 fixture production admission only (NO provider/native host/credentials)',
  () => {
    it.each(['openai-codex', 'gemini'] as const)(
      'freezes %s at creation and lets the real controller create the first root ledger',
      async (providerRoute) => {
        if (process.env.DATABASE_URL || process.env.ALLRICE_TEST_DATABASE_URL)
          throw Error('P27 fixture test refuses inherited database URLs');
        vi.stubEnv('ALLRICE_TEST_DATABASE_URL', FIXTURE_DATABASE_URL);
        vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
        vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
        vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
        const [
          { createAssistantFixtureDatabase },
          { createP27AssistantFixture },
          { productionAssistantController },
          { assertAssistantAuthority },
          { LocalStorageAdapter },
          { riceToolDefinitions },
          { createAssistantRuntime },
          { createAssistantPricing },
          { runtimePolicyDigest },
        ] = await Promise.all([
          import('../../../packages/database/src/assistant-runtime.fixture.ts'),
          import('./p27-assistant-fixture.ts'),
          import('../../../apps/worker/src/harness/dsh/assistant-controller.ts'),
          import('../../../packages/database/src/assistant-authority.ts'),
          import('../../../packages/storage/src/index.ts'),
          import('../../../apps/worker/src/tool-broker.ts'),
          import('../../../packages/database/src/assistant-runtime.ts'),
          import('../../../packages/database/src/assistant-pricing.ts'),
          import('../../../packages/database/src/runtime-policy.ts'),
        ]);
        const database = await createAssistantFixtureDatabase();
        const temporary = await mkdtemp(
          join(tmpdir(), 'allrice-p27-fixture-test-'),
        );
        try {
          const f = await createP27AssistantFixture(database.db, providerRoute);
          expect(f.manifest.provider).toEqual(selectedProvider(providerRoute));
          expect(
            await database.db`select root_run_id from allrice_runtime_roots`,
          ).toHaveLength(0);
          const controller = productionAssistantController({
            configuration: f.config,
            context: f.executionContext,
            worker: f.worker,
            database: database.db,
            storage: new LocalStorageAdapter(temporary),
            authorize: assertAssistantAuthority,
            runLimits: f.runLimits,
            priceSnapshot: f.priceBinding?.snapshot,
            serverPricingProviderSnapshot: f.priceBinding
              ? selectedProvider(providerRoute)
              : undefined,
            tools: riceToolDefinitions.filter((tool) =>
              ['assistant.delegate', 'assistant.report'].includes(tool.name),
            ),
          });
          expect(controller).toBeDefined();
          const nativeSessionId = `dsh-${f.session}`;
          const bound = await controller!.bind(
            nativeSessionId,
            f.worker.generation,
          );
          const runtime = createAssistantRuntime({
            database: database.db,
            authorize: assertAssistantAuthority,
          });
          const tree = await runtime.getTree(f.context, { runId: f.rootRunId });
          expect(tree.instances).toHaveLength(1);
          expect(tree.configuration).toEqual(f.config);
          expect(tree.budgets).toHaveLength(4);
          expect(
            tree.budgets.every(
              (budget) => budget.spent === 0 && budget.reserved === 0,
            ),
          ).toBe(true);
          expect(
            tree.budgets.find((budget) => budget.metric === 'model_calls')
              ?.capacity,
          ).toBe(16);
          expect(
            tree.budgets.find((budget) => budget.metric === 'input_tokens')
              ?.capacity,
          ).toBe(80000);
          expect(
            tree.budgets.find((budget) => budget.metric === 'output_tokens')
              ?.capacity,
          ).toBe(12000);
          const frozen =
            await database.db`select snapshot_digest,snapshot from allrice_assistant_price_snapshots where root_run_id=${f.rootRunId}`;
          expect(frozen).toHaveLength(providerRoute === 'gemini' ? 1 : 0);
          if (f.priceBinding) {
            expect(frozen[0]!.snapshot).toEqual(f.priceBinding.snapshot);
            const [run] =
              await database.db`select execution_spec from allrice_runs where id=${f.rootRunId}`;
            expect(run!.execution_spec.isolatedAssistantPriceSnapshot).toEqual(
              f.priceBinding.snapshot,
            );
            expect(f.runLimits.maxCostCents).toBe(11);
            // Protocol-level synthetic calls only: no native host, resolver,
            // Google, or fabricated claims about provider usage.
            for (let index = 0; index < 2; index++) {
              const callId = randomUUID();
              const requestDigest = runtimePolicyDigest({
                syntheticP27Call: index,
              });
              await bound.handle('model-prepare', {
                nativeSessionId,
                callId,
                outputTokens: 2,
              });
              await bound.handle('model-dispatch', {
                nativeSessionId,
                callId,
                inputTokens: 10,
                outputTokens: 2,
                requestDigest,
              });
              await bound.handle('model-settle', {
                nativeSessionId,
                callId,
                inputTokens: 10,
                outputTokens: 2,
                requestDigest,
              });
            }
            const pricing = createAssistantPricing({ database: database.db });
            const summary = await pricing.summarize({
              scope: {
                organizationId: f.org,
                workspaceId: f.workspace,
                projectId: null,
              },
              rootRunId: f.rootRunId,
              worker: f.worker,
            });
            const admissions = await database.db<
              P27PricedAdmission[]
            >`select call_id,run_id,request_digest,dispatched_at,finished_at from allrice_assistant_model_admissions where root_run_id=${f.rootRunId}`;
            const receipts = await database.db<
              P27CostReceipt[]
            >`select call_id,run_id,snapshot_digest,request_digest,usage,usage_complete,cache_usage_known,cost_basis,actual_cost_known,cost_picounits from allrice_assistant_cost_receipts where root_run_id=${f.rootRunId}`;
            expect(
              verifyP27PricingReceipts({
                snapshot: f.priceBinding.snapshot,
                snapshotDigest: runtimePolicyDigest(f.priceBinding.snapshot),
                admissions,
                receipts,
                modelCalls: 2,
                settledUsage: { inputTokens: 20, outputTokens: 4 },
                summary,
              }),
            ).toMatchObject({
              callCount: 2,
              costPicounits: '30000000',
              costCentsDecimal: '0.003000',
              actualCostKnown: false,
              cacheUsageKnown: false,
            });
            expect(bound.finish).toBeTypeOf('function');
            expect(await bound.finish!()).toMatchObject({
              costEstimateAvailable: true,
              estimatedCostCents: 0.003,
              costBasis: 'conservative_upper_bound',
              actualCostKnown: false,
            });
          } else expect(f.runLimits).toEqual(RUN_LIMITS);
        } finally {
          await database.close();
          await rm(temporary, { recursive: true });
          vi.unstubAllEnvs();
        }
      },
      120000,
    );
  },
);
