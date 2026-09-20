/** Real UUID-isolated allrice_b2 fixtures. No credential resolution or model I/O. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RouteDecisionSchema,
  resolveAssistantSubscriptionSnapshot,
} from '@allrice/contracts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  recordRouteDecision,
  completeRouteDecision,
} from './execution/route-decision.ts';
import {
  freezeRouteSubscriptionSnapshot,
  verifyRouteSubscriptionSnapshot,
} from './execution/route-subscription.ts';
import {
  getOrganizationModelQuota,
  assertQuotaAvailable,
  admitModelExecution,
} from './providers/model-governance.ts';
import {
  checkCompletedModelBudget,
  modelAdmissionTokenEstimate,
} from '../../../apps/worker/src/model-result-budget.ts';
import { completeJob, appendJobEvent } from './execution/queue.ts';
import { getChatSessionHistory } from './workspace/service.ts';
import { listDshRuntimeEventTimeline } from './conversation/conversation-runtime.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'subscription cost applicability and historical unknown preservation',
  { timeout: 30_000 },
  () => {
    beforeAll(() => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    });
    afterAll(() => vi.unstubAllEnvs());
    async function scenario(
      run: (value: Awaited<ReturnType<typeof prepare>>) => Promise<void>,
    ) {
      const f = await prepare();
      try {
        await run(f);
      } finally {
        expect(await f.fixture.close()).toMatchObject({
          globalDatabaseClosed: true,
          databaseEnvironmentRestored: true,
          fixture: {
            schemaRemoved: true,
            storageRemoved: true,
            databaseClosed: true,
            adminClosed: true,
          },
        });
      }
    }
    async function prepare() {
      const fixture = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
      });
      try {
        const task = await fixture.prepareOrdinaryTask(
          'Synthetic, no model execution.',
        );
        const frozen = task.binding.executionSnapshot.modelSnapshot!;
        const decision = RouteDecisionSchema.parse({
          schemaVersion: 1,
          id: randomUUID(),
          runId: task.runId,
          organizationId: fixture.organizationId,
          workspaceId: fixture.workspaceId,
          actorId: fixture.ownerId,
          employeeId: fixture.employeeId,
          inputChecksum: `sha256:${'a'.repeat(64)}`,
          candidates: [
            {
              id: 'direct:synthetic',
              kind: 'direct',
              name: 'Synthetic',
              bindingId: null,
              requiredCapabilities: ['model:invoke'],
              risk: 'low',
              requiresApproval: false,
              authorized: true,
              exclusionReason: null,
              score: 1,
            },
          ],
          selectedKind: 'direct',
          selectedCandidateId: 'direct:synthetic',
          harness: 'dsh',
          provider: 'openai-codex',
          model: frozen.model,
          modelConnectionId: fixture.connectionId,
          modelCatalogEntryId: fixture.catalogId,
          modelPolicyRevision: frozen.policyRevision,
          generation: 1,
          attempt: 1,
          reasonCodes: ['direct_no_capability_match'],
          createdAt: new Date().toISOString(),
        });
        await recordRouteDecision(decision, fixture.db);
        const snapshot = resolveAssistantSubscriptionSnapshot({
          sessionId: task.sessionId,
          modelSnapshot: frozen,
          decision,
          providerSnapshot: {
            provider: 'dsh',
            route: 'openai-codex',
            authMode: 'platform_subscription',
            model: frozen.model,
            credentialReference: frozen.credentialReference!,
            baseUrl: null,
            reasoningEffort: frozen.reasoningEffort,
          },
        })!;
        const identity = {
          organizationId: fixture.organizationId,
          workspaceId: fixture.workspaceId,
          decisionId: decision.id,
          snapshot,
        };
        const outcome = {
          decisionId: decision.id,
          status: 'succeeded' as const,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 2,
          costCents: null,
          usageComplete: true,
          cacheUsageKnown: false,
          errorCode: null,
          completedAt: new Date().toISOString(),
        };
        const complete = (
          value: Parameters<
            typeof completeRouteDecision
          >[0]['outcome'] = outcome,
        ) =>
          completeRouteDecision(
            {
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
              outcome: value,
            },
            fixture.db,
          );
        return {
          fixture,
          task,
          decision,
          snapshot,
          identity,
          outcome,
          complete,
        };
      } catch (error) {
        await fixture.close();
        throw error;
      }
    }
    it('freezes immutable N/A proof, preserves real tokens and never emits a price receipt', () =>
      scenario(async (f) => {
        const proof = await freezeRouteSubscriptionSnapshot(
          f.identity,
          f.fixture.db,
        );
        expect(proof.frozen).toBe(true);
        expect(
          await freezeRouteSubscriptionSnapshot(f.identity, f.fixture.db),
        ).toEqual({ ...proof, frozen: false });
        expect(
          await verifyRouteSubscriptionSnapshot(
            { ...f.identity, runId: f.task.runId },
            f.fixture.db,
          ),
        ).toEqual({ snapshotDigest: proof.snapshotDigest });
        await expect(
          verifyRouteSubscriptionSnapshot(
            { ...f.identity, runId: randomUUID() },
            f.fixture.db,
          ),
        ).rejects.toThrow('UNVERIFIED');
        await expect(
          f.fixture
            .db`update allrice_route_subscription_snapshots set snapshot=snapshot where route_decision_id=${f.decision.id}`,
        ).rejects.toThrow('IMMUTABLE');
        await expect(
          f.complete({ ...f.outcome, costCents: 0 }),
        ).rejects.toThrow('cannot record a monetary charge');
        await f.complete();
        const quota = await getOrganizationModelQuota(
          f.fixture.organizationId,
          f.fixture.db,
        );
        expect(quota).toMatchObject({
          usedTokens: 12,
          usedRuns: 1,
          usedCostCents: 0,
          subscriptionRuns: 1,
          unknownCostRuns: 0,
          usageComplete: true,
          cacheUsageKnown: false,
        });
        expect(() =>
          assertQuotaAvailable(
            { ...quota, monthlyCostLimitCents: 0 },
            'subscription',
          ),
        ).not.toThrow();
        expect(() =>
          assertQuotaAvailable({ ...quota, monthlyCostLimitCents: 0 }),
        ).toThrow('MODEL_COST_QUOTA_EXCEEDED');
        const [row] = await f.fixture
          .db`select l.cost_cents,d.cost_cents as route_cost,
      (select count(*)::int from allrice_assistant_price_snapshots) as prices,
      (select count(*)::int from allrice_assistant_cost_receipts) as receipts
      from allrice_model_usage_ledger l join allrice_route_decisions d on d.id=l.route_decision_id where d.id=${f.decision.id}`;
        expect(row).toEqual({
          cost_cents: null,
          route_cost: null,
          prices: 0,
          receipts: 0,
        });
        await f.fixture
          .db`insert into allrice_organization_model_quotas(organization_id,monthly_cost_limit_cents) values(${f.fixture.organizationId},0)`;
        await expect(
          admitModelExecution({
            organizationId: f.fixture.organizationId,
            workspaceId: f.fixture.workspaceId,
            userId: f.fixture.ownerId,
            employeeId: f.fixture.employeeId,
            connectionId: f.fixture.connectionId,
            requestedTokens: 100,
            requestedRuntimeMs: 1000,
          }),
        ).resolves.toBeDefined();
      }));
    it('admits a small first call without a legacy total hold, settles all multi-call usage, and still denies an exhausted month', () =>
      scenario(async (f) => {
        const limits =
          f.task.binding.executionSnapshot.modelSnapshot!.runLimits;
        const snapshotBefore = structuredClone(
          f.task.binding.executionSnapshot.modelSnapshot,
        );
        const scope = { verifiedSubscription: true, governedAssistants: false };
        await freezeRouteSubscriptionSnapshot(f.identity, f.fixture.db);
        await f.fixture
          .db`insert into allrice_organization_model_quotas(organization_id,monthly_token_limit) values(${f.fixture.organizationId},1000)`;
        const admission = {
          organizationId: f.fixture.organizationId,
          workspaceId: f.fixture.workspaceId,
          userId: f.fixture.ownerId,
          employeeId: f.fixture.employeeId,
          connectionId: f.fixture.connectionId,
          requestedRuntimeMs: 1000,
          requestedTokens: modelAdmissionTokenEstimate({
            ...scope,
            limits,
            estimatedInputTokens: 100,
          }),
        };
        expect(admission.requestedTokens).toBe(612);
        await expect(
          admitModelExecution({
            ...admission,
            requestedTokens: limits.maxTotalTokens,
          }),
        ).rejects.toMatchObject({ code: 'MODEL_TOKEN_QUOTA_EXCEEDED' });
        await expect(admitModelExecution(admission)).resolves.toBeDefined();
        const usage = {
          inputTokens: 203744,
          cachedInputTokens: 173568,
          outputTokens: 4677,
        };
        const result = {
          provider: 'openai-codex',
          model: f.snapshot.model,
          answer: '完整答案',
          usageComplete: true,
          usage,
        };
        expect(
          checkCompletedModelBudget({
            ...scope,
            limits,
            result,
            costCents: null,
          }),
        ).toBeUndefined();
        await f.complete({ ...f.outcome, ...usage, cacheUsageKnown: true });
        await completeJob({ ...f.task.workflowLease, result });
        const history = await getChatSessionHistory(
          f.fixture.context,
          f.fixture.workspaceId,
          f.task.sessionId,
        );
        const message = history.messages.find((m) => m.runId === f.task.runId)!;
        expect(message.status).toBe('completed');
        expect(message.content.text).toBe('完整答案');
        expect(message.content.budgetWarning).toBeUndefined();
        expect(
          await getOrganizationModelQuota(
            f.fixture.organizationId,
            f.fixture.db,
          ),
        ).toMatchObject({
          usedTokens: 208421,
          usageComplete: true,
          cacheUsageKnown: true,
        });
        await expect(admitModelExecution(admission)).rejects.toMatchObject({
          code: 'MODEL_TOKEN_QUOTA_EXCEEDED',
        });
        expect(f.task.binding.executionSnapshot.modelSnapshot).toEqual(
          snapshotBefore,
        );
      }));
    it('projects durable per-Run receipts once across events and attempts, with missing/cache-unknown states', () =>
      scenario(async (f) => {
        const current = async () =>
          (await listDshRuntimeEventTimeline(f.task.sessionId)).turns.find(
            (t) => t.run.id === f.task.runId,
          )!.usage!;
        expect(await current()).toMatchObject({
          totalTokens: null,
          cachedInputTokens: null,
          usageComplete: false,
          receiptCount: 0,
          attemptCount: 1,
        });
        await freezeRouteSubscriptionSnapshot(f.identity, f.fixture.db);
        await f.complete({
          ...f.outcome,
          inputTokens: 203744,
          cachedInputTokens: 173568,
          outputTokens: 4677,
          cacheUsageKnown: true,
        });
        // Several timeline events must not multiply a single ledger receipt.
        for (let index = 0; index < 3; index++)
          await appendJobEvent({
            ...f.task.workflowLease,
            type: 'usage.updated',
            payload: { inputTokens: 203744, outputTokens: 4677 },
          });
        expect(await current()).toMatchObject({
          totalTokens: 208421,
          usageComplete: false,
        });
        await completeJob({
          ...f.task.workflowLease,
          result: { answer: '完整答案' },
        });
        expect(await current()).toEqual({
          totalTokens: 208421,
          inputTokens: 203744,
          outputTokens: 4677,
          cachedInputTokens: 173568,
          usageComplete: true,
          cacheUsageKnown: true,
          attemptCount: 1,
          receiptCount: 1,
        });
        const retry = { ...f.decision, id: randomUUID(), attempt: 2 };
        await recordRouteDecision(retry, f.fixture.db);
        expect(await current()).toMatchObject({
          totalTokens: 208421,
          usageComplete: false,
          cachedInputTokens: null,
          attemptCount: 2,
          receiptCount: 1,
        });
        await freezeRouteSubscriptionSnapshot(
          { ...f.identity, decisionId: retry.id },
          f.fixture.db,
        );
        await f.complete({
          ...f.outcome,
          decisionId: retry.id,
          inputTokens: 1000,
          outputTokens: 12,
          cachedInputTokens: 0,
          usageComplete: false,
          cacheUsageKnown: false,
        });
        expect(await current()).toEqual({
          totalTokens: 209433,
          inputTokens: 204744,
          outputTokens: 4689,
          cachedInputTokens: null,
          usageComplete: false,
          cacheUsageKnown: false,
          attemptCount: 2,
          receiptCount: 2,
        });
        expect((await listDshRuntimeEventTimeline(randomUUID())).turns).toEqual(
          [],
        );
      }));
    it('cannot retroactively reinterpret historical subscription NULL as N/A', () =>
      scenario(async (f) => {
        await f.complete();
        await expect(
          freezeRouteSubscriptionSnapshot(f.identity, f.fixture.db),
        ).rejects.toThrow('FREEZE_TOO_LATE');
        const next = { ...f.decision, id: randomUUID(), attempt: 2 };
        await recordRouteDecision(next, f.fixture.db);
        await freezeRouteSubscriptionSnapshot(
          { ...f.identity, decisionId: next.id },
          f.fixture.db,
        );
        await f.complete({ ...f.outcome, decisionId: next.id });
        const quota = await getOrganizationModelQuota(
          f.fixture.organizationId,
          f.fixture.db,
        );
        expect(quota).toMatchObject({
          subscriptionRuns: 1,
          unknownCostRuns: 1,
          usedCostCents: null,
          usedTokens: 24,
        });
        expect(() => assertQuotaAvailable(quota)).toThrow(
          'MODEL_COST_USAGE_UNKNOWN',
        );
        expect(() => assertQuotaAvailable(quota, 'subscription')).not.toThrow();
      }));
    it('subscription monetary N/A never releases unknown tokens or rewrites a completed receipt', () =>
      scenario(async (f) => {
        await freezeRouteSubscriptionSnapshot(f.identity, f.fixture.db);
        await f.complete({ ...f.outcome, usageComplete: false });
        const quota = await getOrganizationModelQuota(
          f.fixture.organizationId,
          f.fixture.db,
        );
        expect(quota).toMatchObject({
          unknownCostRuns: 0,
          subscriptionRuns: 1,
          usageComplete: false,
        });
        expect(() => assertQuotaAvailable(quota, 'subscription')).toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
        await expect(f.complete()).rejects.toThrow('outcome conflict');
      }));
    const refusal = (f: Awaited<ReturnType<typeof prepare>>, fresh = false) =>
      completeRouteDecision(
        {
          organizationId: f.fixture.organizationId,
          workspaceId: f.fixture.workspaceId,
          undispatched: { subscriptionSnapshotCreated: fresh },
          outcome: {
            ...f.outcome,
            status: 'failed',
            inputTokens: 0,
            outputTokens: 0,
            costCents: 0,
            usageComplete: true,
            cacheUsageKnown: true,
            errorCode: 'MODEL_TOKEN_USAGE_UNKNOWN',
          },
        },
        f.fixture.db,
      );
    const saved = (f: Awaited<ReturnType<typeof prepare>>) => f.fixture.db`
      select to_jsonb(d) as decision,to_jsonb(l) as ledger
      from allrice_route_decisions d
      left join allrice_model_usage_ledger l on l.route_decision_id=d.id
      where d.id=${f.decision.id}`;
    it.each([false, true])(
      "refusal preserves N/A while only this attempt's new proof certifies no prior dispatch (fresh %s)",
      (fresh) =>
        scenario(async (f) => {
          const created = await freezeRouteSubscriptionSnapshot(
            f.identity,
            f.fixture.db,
          );
          const recovered = await freezeRouteSubscriptionSnapshot(
            f.identity,
            f.fixture.db,
          );
          await refusal(f, fresh ? created.frozen : recovered.frozen);
          const [row] = await saved(f);
          for (const value of [row!.decision, row!.ledger])
            expect(value).toMatchObject({
              status: 'failed',
              cost_cents: null,
              input_tokens: 0,
              output_tokens: 0,
              usage_complete: fresh,
              cache_usage_known: false,
            });
          expect(row!.decision).toMatchObject({
            error_code: 'MODEL_TOKEN_USAGE_UNKNOWN',
          });
          const quota = await getOrganizationModelQuota(
            f.fixture.organizationId,
            f.fixture.db,
          );
          expect(quota).toMatchObject({
            subscriptionRuns: 1,
            unknownCostRuns: 0,
            usageComplete: fresh,
          });
          if (fresh)
            expect(() =>
              assertQuotaAvailable(quota, 'subscription'),
            ).not.toThrow();
          else
            expect(() => assertQuotaAvailable(quota, 'subscription')).toThrow(
              'MODEL_TOKEN_USAGE_UNKNOWN',
            );
        }),
    );
    it.each([true, false])(
      'an undispatched refusal atomically preserves an existing whole receipt (known %s)',
      (usageComplete) =>
        scenario(async (f) => {
          await freezeRouteSubscriptionSnapshot(f.identity, f.fixture.db);
          await f.complete({ ...f.outcome, usageComplete });
          const before = await saved(f);
          await Promise.all([refusal(f), refusal(f)]);
          expect(await saved(f)).toEqual(before);
        }),
    );
    it('rechecks the receipt after a real tenant-lock wait and preserves a concurrent writer', () =>
      scenario(async (f) => {
        await freezeRouteSubscriptionSnapshot(f.identity, f.fixture.db);
        const key = `tenant:${f.fixture.organizationId}`;
        const locks = async (granted: boolean) => {
          const [row] = await f.fixture
            .db`select count(*)::int as count from pg_locks
            where locktype='advisory' and objsubid=1 and granted=${granted}
              and classid::bigint=((hashtext(${key})::bigint >> 32) & 4294967295)
              and objid::bigint=(hashtext(${key})::bigint & 4294967295)`;
          return row!.count;
        };
        let release!: () => void, ready!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const locked = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const blocker = f.fixture.db.begin(async (tx) => {
          await tx`select id from allrice_route_decisions where id=${f.decision.id} for update`;
          ready();
          await released;
        });
        await locked;
        let writer: Promise<void> | undefined,
          rejected: Promise<void> | undefined;
        try {
          writer = f.complete();
          void writer.catch(() => {});
          await expect.poll(() => locks(true), { timeout: 3000 }).toBe(1);
          rejected = refusal(f);
          void rejected.catch(() => {});
          await expect.poll(() => locks(false), { timeout: 3000 }).toBe(1);
          release();
          await blocker;
          await writer;
          await rejected;
          const [row] = await saved(f);
          expect(row!.decision).toMatchObject({
            status: 'succeeded',
            error_code: null,
            input_tokens: 10,
            output_tokens: 2,
            cost_cents: null,
            usage_complete: true,
          });
          expect(row!.ledger).toMatchObject({
            status: 'succeeded',
            input_tokens: 10,
            output_tokens: 2,
            cost_cents: null,
            usage_complete: true,
          });
          const before = await saved(f);
          await refusal(f);
          expect(await saved(f)).toEqual(before);
        } finally {
          release();
          await blocker;
          await writer?.catch(() => {});
          await rejected?.catch(() => {});
        }
      }));
    it('rejects forged snapshot, provider auth mode, cross-scope proof and corrupt replay', () =>
      scenario(async (f) => {
        await expect(
          freezeRouteSubscriptionSnapshot(
            {
              ...f.identity,
              snapshot: {
                ...f.snapshot,
                credentialReference: 'deployment:forged',
              },
            },
            f.fixture.db,
          ),
        ).rejects.toThrow('UNVERIFIED');
        await expect(
          freezeRouteSubscriptionSnapshot(
            { ...f.identity, workspaceId: randomUUID() },
            f.fixture.db,
          ),
        ).rejects.toThrow('UNVERIFIED');
        await f.fixture
          .db`update allrice_model_providers set auth_mode='api_key' where id=(select provider_id from allrice_model_connections where id=${f.fixture.connectionId})`;
        await expect(
          freezeRouteSubscriptionSnapshot(f.identity, f.fixture.db),
        ).rejects.toThrow('UNVERIFIED');
        await f.complete();
        expect(
          await getOrganizationModelQuota(
            f.fixture.organizationId,
            f.fixture.db,
          ),
        ).toMatchObject({
          unknownCostRuns: 1,
          subscriptionRuns: 0,
          usedCostCents: null,
        });
      }));
  },
);
