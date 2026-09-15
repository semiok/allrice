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
    ])(
      'writes trustworthy subscription N/A and preserves admission for %s',
      async (mode) => {
        const fails = mode !== 'complete';
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
          const execute = vi
            .spyOn(DshHarnessAdapter.prototype, 'execute')
            .mockImplementation(async () => {
              if (mode === 'transport_failure')
                throw Error('synthetic transport failed after dispatch');
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
          if (mode === 'transport_failure')
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
          expect(DshRuntimePool.prototype.acquire).not.toHaveBeenCalled();
          const [ledger] =
            await fixture.db`select l.cost_cents,l.usage_complete,s.snapshot_digest
        from allrice_model_usage_ledger l join allrice_route_subscription_snapshots s on s.route_decision_id=l.route_decision_id`;
          expect(ledger).toMatchObject({
            cost_cents: null,
            usage_complete: !fails,
            snapshot_digest: expect.stringMatching(/^sha256:/),
          });
          const quota = await getOrganizationModelQuota(
            fixture.organizationId,
            fixture.db,
          );
          expect(quota).toMatchObject({
            unknownCostRuns: 0,
            subscriptionRuns: 1,
            usageComplete: !fails,
          });
          if (fails)
            expect(() => assertQuotaAvailable(quota, 'subscription')).toThrow(
              'MODEL_TOKEN_USAGE_UNKNOWN',
            );
          else
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
