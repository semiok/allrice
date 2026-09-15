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
      const fixture = await createP27CodexWorkerFixture();
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
