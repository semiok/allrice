/** MET139 negative lifecycle evidence: real PG/controller + pinned governed
 * native services and loopback synthetic HTTP. No real Codex/Worker claim. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { assertRuntimeFixtureDatabase } from '../../../packages/database/src/runtime-fixture-database.ts';
import {
  closeDatabase,
  getDatabase,
} from '../../../packages/database/src/core/client.ts';
import {
  getOrganizationModelQuota,
  assertQuotaAvailable,
  admitModelExecution,
} from '../../../packages/database/src/providers/model-governance.ts';
import {
  getWorkbenchArtifact,
  readArtifactBytes,
} from '../../../packages/database/src/artifact-review.ts';
import { productionAssistantController } from '../../../apps/worker/src/harness/dsh/assistant-controller.ts';
import {
  createCodexLifecycleScenario,
  type CodexLifecycleMode,
} from './p27-codex-lifecycle-fixture.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'MET139 subscription lifecycle on controlled real native/PG',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBeUndefined();
      const fixtureUrl = new URL(
        process.env.ALLRICE_TEST_DATABASE_URL ?? 'invalid:',
      );
      assertRuntimeFixtureDatabase(fixtureUrl);
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      // Historical enforcement remains supported; explicitly select it instead
      // of treating the new observation default as a regression.
      vi.stubEnv('ALLRICE_CODEX_TOKEN_POLICY', 'enforce');
      database = await createAssistantFixtureDatabase();
      const [scope] = await database.db`select current_schema() as schema`;
      fixtureUrl.searchParams.set(
        'options',
        `-csearch_path=${scope!.schema},public`,
      );
      vi.stubEnv('DATABASE_URL', fixtureUrl.toString());
      const [actual] = await getDatabase()`select current_schema() as schema`;
      expect(actual!.schema).toBe(scope!.schema);
    }, 120000);
    afterAll(async () => {
      try {
        await closeDatabase();
        if (database)
          expect(await database.close()).toMatchObject({
            schemaRemoved: true,
            storageRemoved: true,
            databaseClosed: true,
            adminClosed: true,
          });
      } finally {
        vi.unstubAllEnvs();
      }
    }, 30000);
    async function scenario(
      mode: CodexLifecycleMode,
      run: (
        s: Awaited<ReturnType<typeof createCodexLifecycleScenario>>,
      ) => Promise<void>,
    ) {
      const s = await createCodexLifecycleScenario(database.db, { mode });
      try {
        await run(s);
      } finally {
        expect(await s.close()).toEqual({
          nativeClosed: true,
          storageRemoved: true,
          loopbackClosed: true,
        });
      }
    }
    it.each(['completed', 'partial_failure'] as const)(
      'durably adopts %s; real next-Run admission and a native ordinary turn remain usable',
      async (mode) => {
        await scenario(mode, async (s) => {
          await s.start();
          await expect
            .poll(() => s.native.requests.length, { timeout: 20000 })
            .toBe(3);
          s.releaseChild('A');
          s.releaseChild('B');
          await expect
            .poll(
              async () =>
                (await s.bound.tree()).results.filter(
                  (x) => x.parentAdoptedSeq !== null,
                ).length,
              { timeout: 20000 },
            )
            .toBe(2);
          const outcome = await s.finish();
          expect(outcome).toMatchObject({
            status: mode === 'completed' ? 'completed' : 'partial',
            usageComplete: true,
            billingMode: 'subscription',
            costBasis: 'not_applicable',
            estimatedCostCents: null,
            subscriptionSnapshotDigest: s.proof.snapshotDigest,
          });
          const tree = await s.bound.tree();
          expect(tree.instances).toHaveLength(3);
          expect(tree.messages.every((x) => x.status === 'adopted')).toBe(true);
          expect(tree.instances.every((x) => x.stoppedAt !== null)).toBe(true);
          expect(tree.results.map((x) => x.status).sort()).toEqual(
            mode === 'completed'
              ? ['completed', 'completed']
              : ['failed', 'partial'],
          );
          for (const report of tree.results) {
            expect(report.evidence).toHaveLength(1);
            const artifact = await getWorkbenchArtifact(
              s.f.context,
              s.f.session,
              report.evidence[0]!.id,
              database.db,
            );
            const bytes = await readArtifactBytes(
              s.storage,
              artifact.object,
              140000,
            );
            expect(JSON.parse(Buffer.from(bytes).toString())).toMatchObject({
              kind: 'assistant_generated',
              independentlyVerified: false,
              childRunId: report.runId,
              name: 'report',
            });
            expect(
              await s.bound.handle('settled', {
                nativeSessionId: tree.instances.find(
                  (x) => x.runId === report.runId,
                )!.nativeSessionId,
                stopReason: 'duplicate replay',
              }),
            ).toMatchObject({ deliveryId: report.deliveryId });
          }
          const [calls] =
            await database.db`select count(*)::int as count,count(finished_at)::int as finished from allrice_assistant_model_admissions where root_run_id=${s.f.rootRunId}`;
          expect(calls!.count).toBe(s.native.requests.length);
          expect(calls!.finished).toBe(calls!.count);
          expect(outcome.usage).toMatchObject({
            inputTokens: calls!.count * 20,
            outputTokens: calls!.count * 5,
          });
          await s.project(outcome);
          const quota = await getOrganizationModelQuota(s.f.org, database.db);
          expect(quota).toMatchObject({
            subscriptionRuns: 1,
            unknownCostRuns: 0,
            usageComplete: true,
          });
          expect(() =>
            assertQuotaAvailable(quota, 'subscription'),
          ).not.toThrow();
          await expect(
            admitModelExecution(s.nextAdmission),
          ).resolves.toHaveLength(4);
          // This is an actual ordinary native turn after Run-bound maps release,
          // not a second executeEmployeeRun. The full Worker path has its own suite.
          const requestsBefore = s.native.requests.length;
          await s.client.call('prompt', {
            id: s.f.nativeSessionId,
            text: 'ROOT_PRIVATE next ordinary synthetic task; no assistant tools',
          });
          await s.client.call('idle', { id: s.f.nativeSessionId });
          expect(s.native.requests).toHaveLength(requestsBefore + 1);
          expect(await s.bound.tree()).toEqual(tree);
          expect(
            await database.db`select 1 from allrice_assistant_price_snapshots where root_run_id=${s.f.rootRunId}`,
          ).toHaveLength(0);
          expect(
            await database.db`select 1 from allrice_assistant_cost_receipts where root_run_id=${s.f.rootRunId}`,
          ).toHaveLength(0);
        });
      },
      60000,
    );
    it('single-child cancellation is request-only until actual native drain; sibling and parent remain responsive', async () => {
      await scenario('completed', async (s) => {
        await s.start();
        await expect
          .poll(() => s.native.requests.length, { timeout: 20000 })
          .toBe(3);
        const [a, b] = s.children;
        expect(
          await s.f.runtime.cancelChild(s.f.context, {
            runId: s.f.rootRunId,
            childRunId: a!.runId,
            requestId: randomUUID(),
          }),
        ).toEqual({ cancelRequested: true, stopped: false });
        const pending = await s.bound.tree();
        expect(
          pending.instances.find((x) => x.runId === a!.runId),
        ).toMatchObject({ status: 'cancel_requested', stoppedAt: null });
        expect(
          pending.instances
            .filter((x) => x.runId !== a!.runId)
            .every((x) => x.cancelRequestedAt === null),
        ).toBe(true);
        await s.drain();
        expect(
          (await s.bound.tree()).instances.find((x) => x.runId === a!.runId),
        ).toMatchObject({ status: 'canceled', stoppedAt: expect.any(String) });
        await expect.poll(() => s.native.abortedRequests.length).toBe(1);
        s.releaseChild('B');
        await expect
          .poll(
            async () =>
              (await s.bound.tree()).results.some(
                (x) => x.runId === b!.runId && x.parentAdoptedSeq !== null,
              ),
            { timeout: 20000 },
          )
          .toBe(true);
        expect((await s.bound.tree()).cancelRequested).toBe(false);
        expect((await s.client.snapshot(s.f.nativeSessionId)).live).toBe(true);
        const outcome = await s.finish();
        expect(outcome).toMatchObject({
          status: 'unknown',
          usageComplete: false,
          billingMode: 'subscription',
        });
        await s.project(outcome);
        const quota = await getOrganizationModelQuota(s.f.org, database.db);
        expect(quota).toMatchObject({
          subscriptionRuns: 1,
          unknownCostRuns: 0,
          usageComplete: false,
        });
        expect(() => assertQuotaAvailable(quota, 'subscription')).toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
      });
    }, 60000);
    it('whole-tree cancellation rejects late wakes and only acknowledges the owned native stop', async () => {
      await scenario('completed', async (s) => {
        await s.start();
        await expect
          .poll(() => s.native.requests.length, { timeout: 20000 })
          .toBe(3);
        await s.f.runtime.cancelRoot(s.f.context, {
          runId: s.f.rootRunId,
          requestId: randomUUID(),
        });
        const before = await s.bound.tree();
        expect(
          before.instances.every((x) => x.cancelRequestedAt && !x.stoppedAt),
        ).toBe(true);
        await expect(
          s.bound.handle('delegate', {
            nativeSessionId: s.f.nativeSessionId,
            callId: randomUUID(),
            arguments: {
              label: 'late',
              text: 'late',
              tools: ['assistant.report'],
            },
          }),
        ).rejects.toThrow();
        // A real authority-side late delivery is retained after the tombstone,
        // before native stopping, but can never enqueue another parent wake.
        const child = s.children[0]!;
        const late = await s.f.runtime.recordResult({
          ...s.f.base,
          runId: child.runId,
          result: {
            deliveryId: randomUUID(),
            status: 'partial',
            summary: 'Synthetic late evidence',
            evidence: [],
            incomplete: ['late'],
            usageComplete: false,
          },
        });
        expect(late.wakeParent).toBe(false);
        await s.drain();
        await expect.poll(() => s.native.abortedRequests.length).toBe(2);
        s.releaseChild('A');
        s.releaseChild('B');
        await s.client.call('p25/flush');
        const after = await s.bound.tree();
        expect(
          after.instances.every((x) => x.status === 'canceled' && x.stoppedAt),
        ).toBe(true);
        expect(s.native.requests).toHaveLength(3);
        expect(
          (await s.bound.tree()).results.every(
            (x) => x.parentAdoptedSeq === null,
          ),
        ).toBe(true);
        await expect(s.bound.finish!()).rejects.toThrow('canceled');
        // No successful Worker projection exists; actual new-Run admission must
        // still find the orphaned dispatched holds under the tenant lock.
        await expect(admitModelExecution(s.nextAdmission)).rejects.toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
      });
    }, 60000);
    it('missing native usage remains unknown; replacement controller quarantines and never replays the model', async () => {
      await scenario('unknown_usage', async (s) => {
        await s.start();
        s.releaseChild('A');
        s.releaseChild('B');
        await expect
          .poll(async () => (await s.bound.tree()).results.length, {
            timeout: 20000,
          })
          .toBe(2);
        const outcome = await s.finish();
        expect(outcome).toMatchObject({
          status: 'unknown',
          usageComplete: false,
          costBasis: 'not_applicable',
        });
        const before = await s.bound.tree(),
          requests = s.native.requests.length;
        expect(before.budgets.some((x) => x.reserved > 0)).toBe(true);
        await s.project(outcome);
        const replacement = {
          ...s.controllerInput.worker,
          leaseToken: randomUUID(),
        };
        await database.db`update allrice_jobs set lease_token=${replacement.leaseToken} where id=${s.f.worker.jobId}`;
        const controller = productionAssistantController({
          ...s.controllerInput,
          worker: replacement,
        })!;
        await expect(
          controller.bind(
            s.f.nativeSessionId,
            s.f.worker.generation,
            undefined,
            (id) => s.client.call('p25/inspect', { nativeSessionId: id }),
          ),
        ).rejects.toThrow('assistant_recovery_required_no_replay');
        expect(s.native.requests).toHaveLength(requests);
        const after = await s.bound.tree();
        expect(after.budgets).toEqual(before.budgets);
        const quota = await getOrganizationModelQuota(s.f.org, database.db);
        expect(() => assertQuotaAvailable(quota, 'subscription')).toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
      });
    }, 60000);
    it.each(['membership', 'policy', 'employee'] as const)(
      'current %s revocation drains owned transport without inventing usage or stop receipts',
      async (kind) => {
        await scenario('completed', async (s) => {
          await s.start();
          await expect
            .poll(() => s.native.requests.length, { timeout: 20000 })
            .toBe(3);
          if (kind === 'membership')
            await database.db`update allrice_memberships set active=false where id=${s.f.membership}`;
          else if (kind === 'employee')
            await database.db`update allrice_employees set status='archived' where id=${s.f.employee}`;
          else
            await s.f.setControls({
              version: 1,
              enabled: true,
              mode: 'execute',
              rules: [{ action: 'assistant.delegate', effect: 'deny' }],
            });
          await expect(s.bound.cancellation()).rejects.toThrow();
          // Simulate loss of the already-owned host after a failed current-
          // authority poll. SIGKILL supplies no graceful stop/usage receipt.
          await s.client.crash();
          await expect.poll(() => s.native.abortedRequests.length).toBe(2);
          const rows =
            await database.db`select stopped_at from allrice_assistant_instances where root_run_id=${s.f.rootRunId} and depth>0`;
          expect(rows).toHaveLength(2);
          expect(rows.every((x) => x.stopped_at === null)).toBe(true);
          const [usage] =
            await database.db`select count(*)::int as count from allrice_assistant_usage where root_run_id=${s.f.rootRunId} and settled_amount is null`;
          expect(usage!.count).toBeGreaterThan(0);
          expect(
            await database.db`select 1 from allrice_assistant_results where root_run_id=${s.f.rootRunId}`,
          ).toHaveLength(0);
          expect(s.native.requests).toHaveLength(3);
          // Model resource admission alone is not an actor permission check.
          // Make the crashed lease durably expired, then use production recovery
          // to quarantine its still-dispatched holds before trying a new Run.
          await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${s.f.worker.jobId}`;
          await s.f.runtime.quarantineExpired({
            scope: s.f.task.scope,
            rootRunId: s.f.rootRunId,
          });
          await expect(admitModelExecution(s.nextAdmission)).rejects.toThrow(
            'MODEL_TOKEN_USAGE_UNKNOWN',
          );
        });
      },
      60000,
    );
    it('real over-reservation native usage is retained and cancels the root instead of being zeroed or marked missing', async () => {
      await scenario('over_budget', async (s) => {
        await s.start();
        await expect
          .poll(() => s.native.requests.length, { timeout: 20000 })
          .toBe(3);
        s.releaseChild('A');
        await expect
          .poll(async () => (await s.bound.tree()).cancelRequested, {
            timeout: 20000,
          })
          .toBe(true);
        const tree = await s.bound.tree();
        expect(
          tree.budgets.find((x) => x.metric === 'output_tokens'),
        ).toMatchObject({ capacity: 6000, spent: 6006 });
        expect(tree.instances.every((x) => x.cancelRequestedAt !== null)).toBe(
          true,
        );
        const [receipt] =
          await database.db`select settled_amount from allrice_assistant_usage where run_id=${s.children[0]!.runId} and metric='output_tokens' and settled_amount is not null`;
        expect(Number(receipt!.settled_amount)).toBe(6001);
        await s.drain();
        const calls = s.native.requests.length;
        s.releaseChild('B');
        await s.client.call('p25/flush');
        expect(s.native.requests.length).toBe(calls);
        expect((await s.bound.tree()).instances.every((x) => x.stoppedAt)).toBe(
          true,
        );
        await expect(s.bound.finish!()).rejects.toThrow('canceled');
        // B was interrupted without a receipt. A's actual overage is retained;
        // missing Worker projection cannot unlock another Run.
        await expect(admitModelExecution(s.nextAdmission)).rejects.toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
      });
    }, 60000);
    it.each(['unknown_usage', 'over_budget'] as const)(
      'observe mode keeps %s receipts and allows later work without canceling a delivered task',
      async (mode) => {
        vi.stubEnv('ALLRICE_CODEX_TOKEN_POLICY', 'observe');
        try {
          await scenario(mode, async (s) => {
            await s.start();
            s.releaseChild('A');
            s.releaseChild('B');
            await expect
              .poll(
                async () =>
                  (await s.bound.tree()).results.filter(
                    (r) => r.parentAdoptedSeq !== null,
                  ).length,
                { timeout: 20000 },
              )
              .toBe(2);
            const outcome = await s.finish();
            expect(outcome).toMatchObject({
              status: 'completed',
              usageComplete: mode !== 'unknown_usage',
              billingMode: 'subscription',
            });
            const tree = await s.bound.tree();
            expect(tree.cancelRequested).toBe(false);
            if (mode === 'over_budget') {
              const budget = tree.budgets.find(
                (b) => b.metric === 'output_tokens',
              )!;
              expect(budget.spent).toBeGreaterThan(budget.capacity);
            }
            await s.project(outcome);
            const quota = await getOrganizationModelQuota(s.f.org, database.db);
            expect(quota.usageComplete).toBe(mode !== 'unknown_usage');
            expect(() =>
              assertQuotaAvailable(quota, 'subscription'),
            ).not.toThrow();
            await expect(
              admitModelExecution(s.nextAdmission),
            ).resolves.toHaveLength(4);
          });
        } finally {
          vi.stubEnv('ALLRICE_CODEX_TOKEN_POLICY', 'enforce');
        }
      },
      60000,
    );
    it('SIGKILL recovery adopts actual persisted native message IDs but cannot redispatch uncertain subscription work', async () => {
      const s = await createCodexLifecycleScenario(database.db, {
        loseCheckpointAck: true,
      });
      try {
        await s.start();
        await expect
          .poll(() => s.native.requests.length, { timeout: 20000 })
          .toBe(3);
        expect(
          (await s.bound.tree()).messages.every((x) => x.status === 'accepted'),
        ).toBe(true);
        await s.client.crash();
        const replacement = {
          ...s.controllerInput.worker,
          leaseToken: randomUUID(),
        };
        await database.db`update allrice_jobs set lease_token=${replacement.leaseToken} where id=${s.f.worker.jobId}`;
        const cold = s.native.launch();
        await cold.call('ready');
        const controller = productionAssistantController({
          ...s.controllerInput,
          worker: replacement,
        })!;
        await expect(
          controller.bind(
            s.f.nativeSessionId,
            s.f.worker.generation,
            undefined,
            (id) => cold.call('p25/inspect', { nativeSessionId: id }),
          ),
        ).rejects.toThrow('assistant_recovery_required_no_replay');
        const tree = await s.bound.tree();
        expect(
          tree.messages.every(
            (x) =>
              x.status === 'adopted' &&
              x.nativeMessageId !== null &&
              x.adoptedSeq !== null,
          ),
        ).toBe(true);
        expect(tree.instances.every((x) => x.status === 'unknown')).toBe(true);
        expect(
          tree.budgets.find((x) => x.metric === 'model_calls')!.reserved,
        ).toBe(2);
        expect(s.native.requests).toHaveLength(3);
        await expect(
          s.bound.handle('model-prepare', {
            nativeSessionId: s.children[0]!.nativeSessionId,
            callId: randomUUID(),
            outputTokens: 10,
          }),
        ).rejects.toThrow();
        expect(s.native.requests).toHaveLength(3);
      } finally {
        expect(await s.close()).toMatchObject({
          nativeClosed: true,
          storageRemoved: true,
          loopbackClosed: true,
        });
      }
    }, 60000);
  },
);
