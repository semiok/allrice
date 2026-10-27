import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_DATABASE_URL,
  RUN_LIMITS,
  selectedProvider,
} from './p27-assistant-preflight.ts';
const integration =
  process.env.ALLRICE_RUN_P27_FIXTURE_TEST === '1' ? describe : describe.skip;
integration(
  'P27 fixture production admission only (NO provider/native host/credentials)',
  () => {
    it.each(['openai-codex'] as const)(
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
        ] = await Promise.all([
          import('../../../packages/database/src/assistant-runtime.fixture.ts'),
          import('./p27-assistant-fixture.ts'),
          import('../../../apps/worker/src/harness/dsh/assistant-controller.ts'),
          import('../../../packages/database/src/assistant-authority.ts'),
          import('../../../packages/storage/src/index.ts'),
          import('../../../apps/worker/src/tool-broker.ts'),
          import('../../../packages/database/src/assistant-runtime.ts'),
        ]);
        const database = await createAssistantFixtureDatabase();
        const temporary = await mkdtemp(
          join(tmpdir(), 'allrice-p27-fixture-test-'),
        );
        try {
          const f = await createP27AssistantFixture(database.db, providerRoute);
          expect(f.manifest.provider).toEqual(selectedProvider());
          expect(
            await database.db`select root_run_id from allrice_runtime_roots`,
          ).toHaveLength(0);
          const controller = productionAssistantController({
            deliveryMode: 'legacy',
            configuration: f.config,
            context: f.executionContext,
            worker: f.worker,
            database: database.db,
            storage: new LocalStorageAdapter(temporary),
            authorize: assertAssistantAuthority,
            runLimits: f.runLimits,
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
          expect(frozen).toHaveLength(0);
          expect(f.runLimits).toEqual(RUN_LIMITS);
          expect(bound.finish).toBeTypeOf('function');
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
