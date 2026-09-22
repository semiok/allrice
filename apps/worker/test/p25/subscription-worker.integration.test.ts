/** Actual ordinary Worker + isolated PG; native acquisition is forbidden and
 * the adapter supplies synthetic usage. No provider or credential is read. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { executeEmployeeRun } from '../../src/jobs/employee-run.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.ts';
import type { DshRuntime } from '../../src/harness/dsh/runtime-pool.ts';
import * as AssistantController from '../../src/harness/dsh/assistant-controller.ts';
import { DshStartupRejection } from '../../src/harness/dsh/startup-rejection.ts';
import { attachAssistantFailureUsage } from '../../src/harness/dsh/assistant-outcome.ts';
import { HandlerError } from '../../src/errors.ts';
import { prepareExecutionIsolation } from '../../src/isolation.ts';
import {
  getOrganizationModelQuota,
  assertQuotaAvailable,
} from '@allrice/database';
import type * as Database from '@allrice/database';
import { CodexSubscriptionQuotaSnapshotSchema } from '@allrice/contracts';

const status = vi.hoisted(() => ({ quota: undefined as unknown }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getCodexProviderStatus: vi.fn(async () => ({
    status: 'connected',
    quota: status.quota,
  })),
}));
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'ordinary Worker subscription projection, no model I/O',
  { timeout: 30_000 },
  () => {
    beforeEach(() => {
      status.quota = undefined;
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      // Any accidental subscription cash estimation would throw, not silently 0.
      vi.stubEnv(
        'ALLRICE_MODEL_PRICING_JSON',
        'invalid-never-parse-for-subscription',
      );
      vi.spyOn(DshRuntimePool.prototype, 'acquire').mockImplementation(
        async () => {
          throw Error('TEST_NATIVE_ACQUISITION_FORBIDDEN');
        },
      );
      vi.spyOn(DshHarnessAdapter.prototype, 'isConfigured').mockReturnValue(
        true,
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    it.each([
      'complete',
      'transport_failure',
      'mismatched_result',
      'missing_usage',
      'quota_exhausted',
      'startup_undispatched',
      'startup_other_run',
      'startup_other_attempt',
      'startup_forged',
      'failed_known_usage',
      'failed_unknown_usage',
      'failed_foreign_usage',
    ])(
      'writes trustworthy subscription N/A and preserves admission for %s',
      async (mode) => {
        const unknownUsage = ![
          'complete',
          'startup_undispatched',
          'failed_known_usage',
        ].includes(mode);
        const temporary = await mkdtemp(
          join(tmpdir(), 'allrice-subscription-worker-test-'),
        );
        // Explicit test-only opt-in; the fixture still accepts only its exact
        // local/CI database URLs. Live Codex smoke callers retain the local pin.
        const fixture = await createP27CodexWorkerFixture({
          allowCiDatabase: true,
        });
        let cleanup: (() => Promise<void>) | undefined;
        try {
          vi.stubEnv('ALLRICE_STORAGE_ROOT', join(temporary, 'storage'));
          const task = await fixture.prepareOrdinaryTask(
            'Synthetic arithmetic.',
          );
          const isolation = await prepareExecutionIsolation({
            root: temporary,
            organizationId: fixture.organizationId,
            workspaceId: fixture.workspaceId,
            ownerId: fixture.ownerId,
            runId: task.runId,
            jobId: task.workflowLease.jobId,
            attempt: 1,
          });
          cleanup = isolation.cleanup;
          if (mode === 'quota_exhausted')
            status.quota = CodexSubscriptionQuotaSnapshotSchema.parse({
              source: 'codex_app_server',
              status: 'available',
              checkedAt: new Date().toISOString(),
              accountFingerprint: `sha256:${'a'.repeat(64)}`,
              detailCode: 'codex_quota_available',
              buckets: [
                {
                  limitId: 'codex',
                  limitReached: true,
                  windows: [
                    {
                      slot: 'primary',
                      status: 'available',
                      usedPercent: 100,
                      windowDurationMins: 300,
                      resetsAt: Math.floor(Date.now() / 1000) + 3600,
                    },
                    {
                      slot: 'secondary',
                      status: 'unknown',
                      usedPercent: null,
                      windowDurationMins: null,
                      resetsAt: null,
                    },
                  ],
                },
              ],
            });
          const nativePrompt = vi.fn(async () => {
            throw Error('TEST_MODEL_DISPATCH_FORBIDDEN');
          });
          const nativeAssistant = vi.fn(async () => {
            throw Error('TEST_NATIVE_ASSISTANT_BIND_FORBIDDEN');
          });
          if (mode === 'startup_undispatched') {
            // Exercise the actual adapter -> Worker -> PG classification. Only
            // the local controller rejection/empty host are fault-injected;
            // no native prompt, credential or model can be reached.
            vi.mocked(DshRuntimePool.prototype.acquire).mockResolvedValue({
              runtime: {
                client: { prompt: nativePrompt, assistant: nativeAssistant },
              } as unknown as DshRuntime,
              fresh: true,
            });
            vi.spyOn(DshRuntimePool.prototype, 'drop').mockResolvedValue();
            vi.spyOn(
              AssistantController,
              'productionAssistantController',
            ).mockImplementation((input) => ({
              rootRunId: input.context.runId,
              subscriptionSnapshot: input.subscriptionSnapshot,
              bind: async () => {
                throw Error('synthetic bind rejected before prompt');
              },
            }));
          }
          const originalExecute = DshHarnessAdapter.prototype.execute;
          const execute = vi
            .spyOn(DshHarnessAdapter.prototype, 'execute')
            .mockImplementation(async function (
              this: DshHarnessAdapter,
              input,
            ) {
              if (mode === 'startup_undispatched')
                return originalExecute.call(this, input);
              if (mode === 'transport_failure')
                throw Error('synthetic transport failed after dispatch');
              if (mode.startsWith('failed_')) {
                const error = new HandlerError(
                  'ASSISTANT_BUDGET_EXHAUSTED',
                  'synthetic internal budget stop',
                  false,
                );
                attachAssistantFailureUsage(
                  error,
                  mode === 'failed_foreign_usage' ? 'another-run' : task.runId,
                  input.attempt,
                  {
                    usage: {
                      inputTokens: 47002,
                      outputTokens: 3214,
                      cachedInputTokens: 0,
                    },
                    usageComplete: mode !== 'failed_unknown_usage',
                    cacheUsageKnown: false,
                  },
                );
                throw error;
              }
              if (mode.startsWith('startup_')) {
                const original = Error('synthetic bind rejected before prompt');
                if (mode === 'startup_forged')
                  throw Object.assign(original, {
                    name: 'DshStartupRejection',
                    undispatched: true,
                    runId: task.runId,
                    attempt: input.attempt,
                  });
                throw new DshStartupRejection(
                  original,
                  mode === 'startup_other_run' ? 'other-run' : task.runId,
                  mode === 'startup_other_attempt'
                    ? input.attempt + 1
                    : input.attempt,
                );
              }
              return {
                answer: 'Synthetic',
                provider: 'openai-codex',
                model:
                  mode === 'mismatched_result'
                    ? 'unverified-model'
                    : 'gpt-5.6-luna',
                usage: {
                  inputTokens: 10,
                  cachedInputTokens: 2,
                  outputTokens: 3,
                },
                usageComplete: mode === 'missing_usage' ? undefined : true,
                cacheUsageKnown: mode === 'missing_usage' ? undefined : true,
              };
            });
          const pending = executeEmployeeRun({
            execution: task.execution,
            isolation,
            signal: new AbortController().signal,
            onHarnessEvent: async () => {},
            workflowLease: task.workflowLease,
          });
          if (mode === 'quota_exhausted') {
            await expect(pending).rejects.toMatchObject({
              code: 'CODEX_SUBSCRIPTION_QUOTA_EXHAUSTED',
            });
            expect(execute).not.toHaveBeenCalled();
            expect(DshRuntimePool.prototype.acquire).not.toHaveBeenCalled();
            const [proof] =
              await fixture.db`select count(*)::int as count from allrice_route_subscription_snapshots`;
            expect(proof?.count).toBe(0);
            return;
          }
          if (mode.startsWith('failed_'))
            await expect(pending).rejects.toMatchObject({
              code: 'ASSISTANT_BUDGET_EXHAUSTED',
              retryable: false,
            });
          else if (mode.startsWith('startup_'))
            await expect(pending).rejects.toThrow(
              'synthetic bind rejected before prompt',
            );
          else if (mode === 'transport_failure')
            await expect(pending).rejects.toThrow('synthetic transport failed');
          else if (mode === 'mismatched_result')
            await expect(pending).rejects.toMatchObject({
              code: 'ASSISTANT_SUBSCRIPTION_RESULT_UNVERIFIED',
            });
          else
            expect(await pending).toMatchObject({
              billingMode: 'subscription',
              costBasis: 'not_applicable',
              estimatedCostCents: null,
              costEstimateAvailable: false,
              actualCostKnown: false,
              subscriptionSnapshotDigest: expect.stringMatching(/^sha256:/),
              usage: { inputTokens: 10, outputTokens: 3 },
            });
          expect(execute).toHaveBeenCalledTimes(1);
          expect(DshRuntimePool.prototype.acquire).toHaveBeenCalledTimes(
            mode === 'startup_undispatched' ? 1 : 0,
          );
          expect(nativePrompt).not.toHaveBeenCalled();
          expect(nativeAssistant).not.toHaveBeenCalled();
          const [ledger] =
            await fixture.db`select l.cost_cents,l.usage_complete,l.input_tokens,l.cached_input_tokens,l.output_tokens,s.snapshot_digest
        from allrice_model_usage_ledger l join allrice_route_subscription_snapshots s on s.route_decision_id=l.route_decision_id`;
          expect(ledger).toMatchObject({
            cost_cents: null,
            usage_complete: !unknownUsage,
            snapshot_digest: expect.stringMatching(/^sha256:/),
          });
          if (['failed_known_usage', 'failed_unknown_usage'].includes(mode))
            expect(ledger).toMatchObject({
              input_tokens: 47002,
              output_tokens: 3214,
              cached_input_tokens: 0,
            });
          if (mode === 'failed_foreign_usage')
            expect(ledger).toMatchObject({ input_tokens: 0, output_tokens: 0 });
          const quota = await getOrganizationModelQuota(
            fixture.organizationId,
            fixture.db,
          );
          expect(quota).toMatchObject({
            unknownCostRuns: 0,
            subscriptionRuns: 1,
            usageComplete: !unknownUsage,
          });
          if (mode === 'startup_undispatched') {
            expect(ledger).toMatchObject({
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
            });
            const [decision] =
              await fixture.db`select status,error_code from allrice_route_decisions`;
            expect(decision).toMatchObject({
              status: 'failed',
              error_code: 'CONVERSATION_FAILED',
            });
          }
          // Unknown accounting must stay unknown, but no longer locks the account.
          expect(() =>
            assertQuotaAvailable(quota, 'subscription'),
          ).not.toThrow();
        } finally {
          await cleanup?.();
          expect(await fixture.close()).toMatchObject({
            globalDatabaseClosed: true,
            databaseEnvironmentRestored: true,
            fixture: {
              schemaRemoved: true,
              storageRemoved: true,
              databaseClosed: true,
              adminClosed: true,
            },
          });
          await rm(temporary, { recursive: true, force: true });
        }
      },
    );
  },
);
