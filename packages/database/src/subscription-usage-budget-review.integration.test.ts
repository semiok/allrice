import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  RouteDecisionSchema,
  resolveAssistantSubscriptionSnapshot,
} from '@allrice/contracts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  recordRouteDecision,
  completeRouteDecision,
} from './execution/route-decision.ts';
import { freezeRouteSubscriptionSnapshot } from './execution/route-subscription.ts';
import {
  getOrganizationModelQuota,
  assertQuotaAvailable,
  admitModelExecution,
} from './providers/model-governance.ts';
import {
  reviewSubscriptionUsageBudget,
  reviewSubscriptionUsageBudgetForAdmin,
  listUnknownSubscriptionUsage,
} from './providers/usage-budget-review.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'explicit subscription unknown-budget recovery (isolated real PG)',
  { timeout: 60_000 },
  () => {
    beforeEach(() => {
      vi.stubEnv('ALLRICE_CODEX_TOKEN_POLICY', 'enforce'); // Legacy opt-in recovery remains testable.
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    });
    afterEach(() => vi.unstubAllEnvs());
    async function setup(proof = true) {
      const f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
      try {
        const task = await f.prepareOrdinaryTask(
          'Synthetic usage recovery; never invoke a model.',
        );
        const frozen = task.binding.executionSnapshot.modelSnapshot!;
        const decision = RouteDecisionSchema.parse({
          schemaVersion: 1,
          id: randomUUID(),
          runId: task.runId,
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          actorId: f.ownerId,
          employeeId: f.employeeId,
          inputChecksum: `sha256:${'a'.repeat(64)}`,
          candidates: [
            {
              id: 'direct:test',
              kind: 'direct',
              name: 'Test',
              bindingId: null,
              requiredCapabilities: [],
              risk: 'low',
              requiresApproval: false,
              authorized: true,
              exclusionReason: null,
              score: 1,
            },
          ],
          selectedKind: 'direct',
          selectedCandidateId: 'direct:test',
          harness: 'dsh',
          provider: 'openai-codex',
          model: frozen.model,
          modelConnectionId: f.connectionId,
          modelCatalogEntryId: f.catalogId,
          modelPolicyRevision: frozen.policyRevision,
          generation: 1,
          attempt: 1,
          reasonCodes: ['direct_no_capability_match'],
          createdAt: new Date().toISOString(),
        });
        await recordRouteDecision(decision, f.db);
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
        if (proof)
          await freezeRouteSubscriptionSnapshot(
            {
              organizationId: f.organizationId,
              workspaceId: f.workspaceId,
              decisionId: decision.id,
              snapshot,
            },
            f.db,
          );
        const outcome = {
          decisionId: decision.id,
          status: 'canceled' as const,
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 20,
          costCents: null,
          usageComplete: false,
          cacheUsageKnown: false,
          errorCode: 'EXECUTION_ABORTED',
          completedAt: new Date().toISOString(),
        };
        await completeRouteDecision(
          {
            organizationId: f.organizationId,
            workspaceId: f.workspaceId,
            outcome,
          },
          f.db,
        );
        const finish = async () => {
          await f.db`update allrice_jobs set status='canceled' where run_id=${task.runId}`;
          await f.db`update allrice_runs set state='failed' where id=${task.runId}`;
        };
        const admin = async () => {
          const [u] =
            await f.db`select email from allrice_users where id=${f.ownerId}`;
          vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', u!.email as string);
        };
        const review = {
          decisionId: decision.id,
          reservedTokens: 1_000_000,
          reason:
            'Explicit operator acceptance for synthetic unknown usage test',
          acceptUnknownUsage: true as const,
        };
        const quota = () => getOrganizationModelQuota(f.organizationId, f.db);
        const apply = (value: unknown = review) =>
          reviewSubscriptionUsageBudget(
            { context: f.context, review: value },
            f.db,
          );
        return {
          f,
          task,
          decision,
          snapshot,
          outcome,
          finish,
          admin,
          review,
          quota,
          apply,
        };
      } catch (e) {
        await f.close();
        throw e;
      }
    }
    async function scenario(
      fn: (v: Awaited<ReturnType<typeof setup>>) => Promise<void>,
      proof = true,
    ) {
      const s = await setup(proof);
      try {
        await fn(s);
      } finally {
        expect(await s.f.close()).toMatchObject({
          globalDatabaseClosed: true,
          fixture: { schemaRemoved: true },
        });
      }
    }

    it('blocks by default and requires a platform admin', () =>
      scenario(async (s) => {
        await s.finish();
        const q = await s.quota();
        expect(() => assertQuotaAvailable(q, 'subscription')).toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
        await expect(s.apply()).rejects.toMatchObject({
          code: 'authorization_denied',
        });
      }));
    it('restores admission with audited budget risk acceptance, never rewrites original accounting', () =>
      scenario(async (s) => {
        await s.finish();
        await expect(s.apply()).rejects.toMatchObject({
          code: 'authorization_denied',
        });
        await s.admin();
        const before = await s.f
          .db`select to_jsonb(l) data from allrice_model_usage_ledger l where route_decision_id=${s.decision.id}`;
        const q = await s.quota();
        expect(q.usageComplete).toBe(false);
        expect(() => assertQuotaAvailable(q, 'subscription')).toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
        const results = await Promise.all([s.apply(), s.apply()]);
        expect(results.filter((r) => !r.replayed)).toHaveLength(1);
        const after = await s.f
          .db`select to_jsonb(l) data from allrice_model_usage_ledger l where route_decision_id=${s.decision.id}`;
        expect(after).toEqual(before);
        const recovered = await s.quota();
        expect(recovered).toMatchObject({
          usedTokens: 120,
          reservedTokenBudget: 1_000_000,
          unknownUsageRuns: 1,
          usageComplete: false,
          subscriptionBudgetAdmissionComplete: true,
        });
        expect(() =>
          assertQuotaAvailable(recovered, 'subscription'),
        ).not.toThrow();
        expect(() => assertQuotaAvailable(recovered, 'token_metered')).toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
        expect(() =>
          assertQuotaAvailable(
            { ...recovered, monthlyTokenLimit: 1_000_120 },
            'subscription',
          ),
        ).toThrow('MODEL_TOKEN_QUOTA_EXCEEDED');
        expect(() =>
          assertQuotaAvailable(
            { ...recovered, monthlyTokenLimit: 1_000_200 },
            'subscription',
            81,
          ),
        ).toThrow('MODEL_TOKEN_QUOTA_EXCEEDED');
        expect(() =>
          assertQuotaAvailable(
            { ...recovered, monthlyTokenLimit: 1_000_200 },
            'subscription',
            80,
          ),
        ).not.toThrow();
        await expect(
          admitModelExecution({
            organizationId: s.f.organizationId,
            workspaceId: s.f.workspaceId,
            userId: s.f.ownerId,
            employeeId: s.f.employeeId,
            connectionId: s.f.connectionId,
            requestedTokens: 100,
            requestedRuntimeMs: 1000,
          }),
        ).resolves.toHaveLength(4);
        expect(await listUnknownSubscriptionUsage(s.f.context, s.f.db)).toEqual(
          [
            expect.objectContaining({
              approved: true,
              eligible: false,
              reservedTokens: 1_000_000,
            }),
          ],
        );
        const [audit] = await s.f
          .db`select count(*)::int count from allrice_audit_events where resource_id=${s.decision.id} and action='model_usage.budget_review'`;
        expect(audit!.count).toBe(1);
        await expect(
          s.apply({ ...s.review, reservedTokens: 1 }),
        ).rejects.toMatchObject({ code: 'USAGE_REVIEW_CONFLICT' });
        await expect(
          s.f
            .db`update allrice_subscription_usage_budget_reviews set reserved_tokens=1 where route_decision_id=${s.decision.id}`,
        ).rejects.toThrow('immutable');
      }));
    it('refuses active tasks, cross-tenant selection and caller-supplied authority', () =>
      scenario(async (s) => {
        await s.admin();
        await expect(s.apply()).rejects.toMatchObject({
          code: 'USAGE_REVIEW_NOT_ELIGIBLE',
        });
        await s.finish();
        await expect(
          reviewSubscriptionUsageBudget(
            {
              context: { ...s.f.context, organizationId: randomUUID() },
              review: s.review,
            },
            s.f.db,
          ),
        ).rejects.toMatchObject({ code: 'not_found' });
        for (const extra of [
          { acceptUnknownUsage: false },
          { reservedTokens: 0 },
          { reservedTokens: -1 },
          { reservedTokens: 1.2 },
          { reason: 'short' },
          { organizationId: s.f.organizationId },
          { usageComplete: true },
        ])
          await expect(s.apply({ ...s.review, ...extra })).rejects.toThrow();
        expect((await s.quota()).subscriptionBudgetAdmissionComplete).toBe(
          false,
        );
      }));
    it('never exempts legacy/API routes lacking a pre-dispatch subscription proof', () =>
      scenario(async (s) => {
        await s.admin();
        await s.finish();
        await expect(s.apply()).rejects.toMatchObject({
          code: 'USAGE_REVIEW_NOT_ELIGIBLE',
        });
        expect(
          (await listUnknownSubscriptionUsage(s.f.context, s.f.db))[0],
        ).toMatchObject({ eligible: false, approved: false });
      }, false));
    it('fails closed after late ledger changes; holds stay charged', () =>
      scenario(async (s) => {
        await s.admin();
        await s.finish();
        await s.apply();
        await completeRouteDecision(
          {
            organizationId: s.f.organizationId,
            workspaceId: s.f.workspaceId,
            outcome: { ...s.outcome, inputTokens: 101 },
          },
          s.f.db,
        );
        const q = await s.quota();
        expect(q).toMatchObject({
          usedTokens: 121,
          reservedTokenBudget: 1_000_000,
          usageComplete: false,
          subscriptionBudgetAdmissionComplete: false,
        });
        expect(() => assertQuotaAvailable(q, 'subscription')).toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
        await expect(s.apply()).rejects.toMatchObject({
          code: 'USAGE_REVIEW_CONFLICT',
        });
      }));
    it('fails closed if the original task reopens', () =>
      scenario(async (s) => {
        await s.admin();
        await s.finish();
        await s.apply();
        await s.f
          .db`update allrice_runs set state='running' where id=${s.task.runId}`;
        const q = await s.quota();
        expect(q.subscriptionBudgetAdmissionComplete).toBe(false);
        expect(() => assertQuotaAvailable(q, 'subscription')).toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
      }));
    it('resolves tenant scope from the selected route only for a platform admin', () =>
      scenario(async (s) => {
        await s.finish();
        const input = {
          context: {
            ...s.f.context,
            organizationId: randomUUID(),
            workspaceId: randomUUID(),
          },
          review: s.review,
        };
        await expect(
          reviewSubscriptionUsageBudgetForAdmin(input, s.f.db),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        await s.admin();
        await expect(
          reviewSubscriptionUsageBudgetForAdmin(input, s.f.db),
        ).resolves.toMatchObject({ replayed: false, usageComplete: false });
        expect((await s.quota()).subscriptionBudgetAdmissionComplete).toBe(
          true,
        );
        const [audit] = await s.f
          .db`select organization_id,workspace_id from allrice_audit_events where resource_id=${s.decision.id} and action='model_usage.budget_review'`;
        expect(audit).toMatchObject({
          organization_id: s.f.organizationId,
          workspace_id: s.f.workspaceId,
        });
      }));
  },
);
