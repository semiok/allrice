/** Actual isolated PG/controller with synthetic bridge observations only.
 * No native host, credential resolver, HTTP request or provider execution. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantFailureDiagnostics } from '../../../apps/worker/src/harness/dsh/assistant-diagnostics.ts';
import { createP27WorkerFixture } from './p27-worker-fixture.ts';
import { createP27GeminiPriceBinding } from './p27-assistant-pricing.ts';
import { correlateP27AssistantDiagnostics } from './p27-assistant-diagnostics.ts';
import {
  summarizeWorkerPricing,
  workerFailureSnapshot,
} from './p27-worker-smoke.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration(
  'P27 Worker report identity and pricing projection (no provider)',
  () => {
    it.each([false, true])(
      'correlates actual frozen price and native mapping; confirmed totals=%s',
      async (complete) => {
        vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
        vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
        vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
        const fixture = await createP27WorkerFixture();
        try {
          const task = await fixture.prepareAssistantTask(
            'Synthetic report identity test.',
          );
          const api = await import('../../../packages/database/src/index.ts');
          const { productionAssistantController } =
            await import('../../../apps/worker/src/harness/dsh/assistant-controller.ts');
          const ownership = {
            organizationId: fixture.organizationId,
            workspaceId: fixture.workspaceId,
            sessionId: task.sessionId,
            runId: task.runId,
            workerId: task.workflowLease.workerId,
          };
          await api.acquireConversationRuntime({
            ...ownership,
            ownerId: fixture.ownerId,
            configChecksum: api.runtimePolicyDigest(
              task.binding.executionSnapshot,
            ),
            compactThresholdTokens: 100000,
          });
          const nativeSessionId = `dsh-${task.sessionId}`;
          const runtime = await api.bindConversationThread({
            ...ownership,
            threadId: nativeSessionId,
          });
          const snapshot = createP27GeminiPriceBinding({
            connectionId: fixture.connectionId,
            catalogId: fixture.catalogId,
            at: new Date().toISOString(),
          }).snapshot;
          const input = task.execution.payload.input;
          if (
            !input ||
            typeof input !== 'object' ||
            !('assistantConfiguration' in input)
          )
            throw Error('P27_TEST_CONFIGURATION_MISSING');
          const controller = productionAssistantController({
            configuration: input.assistantConfiguration,
            context: task.execution.context,
            worker: task.workflowLease,
            runLimits: fixture.runLimits,
            tools: [
              { name: 'assistant.delegate' },
              { name: 'assistant.report' },
            ],
            authorize: api.assertAssistantAuthority,
            database: fixture.db,
            priceSnapshot: snapshot,
          })!;
          const bound = await controller.bind(
            nativeSessionId,
            runtime.generation,
          );
          const callId = randomUUID();
          const requestDigest = api.runtimePolicyDigest({ synthetic: true });
          await bound.handle('model-prepare', {
            nativeSessionId,
            callId,
            outputTokens: 100,
          });
          await bound.handle('model-dispatch', {
            nativeSessionId,
            callId,
            requestDigest,
            inputTokens: 1000,
            outputTokens: 100,
          });
          await bound.handle('model-settle', {
            nativeSessionId,
            callId,
            requestDigest,
            ...(complete ? { inputTokens: 10, outputTokens: 5 } : {}),
          });
          const diagnostics: AssistantFailureDiagnostics = {
            version: 1,
            truncated: false,
            failures: [
              {
                nativeSessionId,
                callId,
                phase: 'finish',
                code: 'SERVER',
                stopKind: 'error',
                inputUsageKnown: complete,
                outputUsageKnown: complete,
                settlementConfirmed: true,
              },
            ],
          };
          expect(nativeSessionId).not.toBe(`dsh-${task.runId}`);
          const report = await workerFailureSnapshot(
            fixture,
            task,
            diagnostics,
          );
          expect(report.nativeDiagnostics).toMatchObject({
            status: 'correlated',
            failures: [
              {
                nativeSessionId,
                callId,
                runId: task.runId,
                receiptPresent: true,
                receiptUsageComplete: complete,
                receiptCostKnown: complete,
              },
            ],
          });
          // Reproduce the old caller omission using the same actual PG rows.
          expect(
            correlateP27AssistantDiagnostics({
              diagnostics,
              admissions: report.admissions,
              receipts: report.receipts,
            }),
          ).toEqual({ status: 'identity_mismatch' });
          expect(
            correlateP27AssistantDiagnostics({
              diagnostics,
              admissions: report.admissions,
              receipts: report.receipts,
              snapshotDigest: `sha256:${'f'.repeat(64)}`,
            }),
          ).toEqual({ status: 'identity_mismatch' });
          for (const changed of [
            { callId: randomUUID() },
            { nativeSessionId: `dsh-${task.runId}` },
          ]) {
            expect(
              (
                await workerFailureSnapshot(fixture, task, {
                  ...diagnostics,
                  failures: [{ ...diagnostics.failures[0]!, ...changed }],
                })
              ).nativeDiagnostics,
            ).toEqual({ status: 'identity_mismatch' });
          }
          expect(
            (
              await workerFailureSnapshot(
                fixture,
                { ...task, runId: randomUUID() },
                diagnostics,
              )
            ).nativeDiagnostics,
          ).toEqual({ status: 'identity_mismatch' });
          await expect(
            workerFailureSnapshot(
              { ...fixture, connectionId: randomUUID() },
              task,
              diagnostics,
            ),
          ).rejects.toThrow('worker_frozen_price_identity');
          const summary = await summarizeWorkerPricing(fixture, task);
          expect(task.workflowLease.leaseMs).toBe(30000);
          expect(summary).toMatchObject({
            usageComplete: complete,
            costBasis: complete ? 'conservative_upper_bound' : 'unknown',
            snapshotDigest: api.runtimePolicyDigest(snapshot),
            actualCostKnown: false,
            cacheUsageKnown: false,
            callCount: 1,
          });
          if (complete)
            expect(Number(summary.costCentsDecimal)).toBeGreaterThan(0);
          else expect(summary.costCentsDecimal).toBeNull();
          await expect(
            summarizeWorkerPricing(fixture, {
              ...task,
              workflowLease: {
                ...task.workflowLease,
                leaseToken: randomUUID(),
              },
            }),
          ).rejects.toThrow('ASSISTANT_PRICING_LEASE_LOST');
        } finally {
          try {
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
          } finally {
            vi.unstubAllEnvs();
          }
        }
      },
      30000,
    );
  },
);
