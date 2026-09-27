import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi, afterEach } from 'vitest';
import { codexTokenPolicy } from './codex-token-policy.ts';

import {
  ModelGovernanceError,
  assertProviderAvailable,
  assertQuotaAvailable,
  assertModelResourceAvailable,
  mapProviderGovernanceRow,
} from './model-governance.js';

const quota = {
  organizationId: randomUUID(),
  monthlyRunLimit: 100,
  monthlyTokenLimit: 10_000,
  monthlyCostLimitCents: 500,
  usedRuns: 1,
  usedTokens: 200,
  usedCostCents: 10,
  unknownCostRuns: 0,
  usageComplete: true,
  cacheUsageKnown: true,
  periodStart: new Date().toISOString(),
};

describe('model governance preflight', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('observes verified subscriptions even over monthly caps with unknown usage; preserves API and concurrency guards', () => {
    vi.stubEnv('ALLRICE_CODEX_TOKEN_POLICY', undefined);
    expect(codexTokenPolicy()).toBe('observe');
    const unknown = {
      ...quota,
      usedRuns: 9999,
      usedTokens: 99_000_000,
      reservedTokenBudget: 1_000_000,
      usageComplete: false,
      usedCostCents: null,
      unknownCostRuns: 1,
    };
    expect(() =>
      assertQuotaAvailable(unknown, 'subscription', 10_000_000),
    ).not.toThrow();
    expect(() => assertQuotaAvailable(unknown, 'token_metered')).toThrow();
    const resource = {
      scope: 'user' as const,
      scopeId: randomUUID(),
      monthlyRunLimit: 100,
      monthlyTokenLimit: 1,
      concurrentRunLimit: 2,
      maxRuntimeMs: 60000,
      usedRuns: 9999,
      usedTokens: 99_000_000,
      activeRuns: 1,
    };
    const request = {
      resources: [resource],
      billingMode: 'subscription' as const,
      requestedTokens: 10_000_000,
      requestedRuntimeMs: 30000,
    };
    expect(() => assertModelResourceAvailable(request)).not.toThrow();
    expect(() =>
      assertModelResourceAvailable({
        ...request,
        resources: [{ ...resource, activeRuns: 2 }],
      }),
    ).toThrow('MODEL_RESOURCE_CONCURRENCY_EXCEEDED');
    expect(() =>
      assertModelResourceAvailable({ ...request, requestedRuntimeMs: 60001 }),
    ).toThrow('MODEL_RUNTIME_LIMIT_EXCEEDED');
    for (const policy of ['enforce', 'invalid']) {
      vi.stubEnv('ALLRICE_CODEX_TOKEN_POLICY', policy);
      expect(codexTokenPolicy()).toBe('observe');
      expect(() => assertQuotaAvailable(unknown, 'subscription')).not.toThrow();
    }
  });
  it('returns safe defaults before a connection has governance rows', () => {
    const connectionId = randomUUID();
    expect(
      mapProviderGovernanceRow(connectionId, {
        kill_switch: null,
        circuit_state: null,
        consecutive_failures: null,
        opened_until: null,
        last_error_code: null,
        updated_at: null,
        release_stage: null,
        production_approved: null,
        allowlisted_organization_ids: null,
      }),
    ).toMatchObject({
      connectionId,
      killSwitch: false,
      circuitState: 'closed',
      updatedAt: null,
      releaseStage: 'experimental',
      productionApproved: false,
    });
  });

  it('keeps task-count admission while ignoring token and cost ceilings', () => {
    expect(() => assertQuotaAvailable(quota)).not.toThrow();
    expect(() =>
      assertQuotaAvailable({ ...quota, usedRuns: quota.monthlyRunLimit }),
    ).toThrow(new ModelGovernanceError('MODEL_RUN_QUOTA_EXCEEDED'));
    expect(() =>
      assertQuotaAvailable({
        ...quota,
        usedTokens: quota.monthlyTokenLimit,
      }),
    ).not.toThrow();
    expect(() =>
      assertQuotaAvailable({
        ...quota,
        usedCostCents: quota.monthlyCostLimitCents,
      }),
    ).not.toThrow();
  });

  it('blocks a killed or open provider before execution', () => {
    const provider = {
      connectionId: randomUUID(),
      killSwitch: false,
      circuitState: 'closed' as const,
      consecutiveFailures: 0,
      openedUntil: null,
      lastErrorCode: null,
      updatedAt: null,
      releaseStage: 'production' as const,
      productionApproved: true,
      allowlistedOrganizationIds: [],
    };
    expect(() => assertProviderAvailable(provider)).not.toThrow();
    expect(() =>
      assertProviderAvailable({ ...provider, killSwitch: true }),
    ).toThrow(new ModelGovernanceError('PROVIDER_KILL_SWITCH'));
    expect(() =>
      assertProviderAvailable({ ...provider, circuitState: 'open' }),
    ).toThrow(new ModelGovernanceError('PROVIDER_CIRCUIT_OPEN'));
  });

  it('does not spend unknown cost or incomplete token usage as if it were zero', () => {
    expect(() =>
      assertQuotaAvailable({
        ...quota,
        usedCostCents: null,
        unknownCostRuns: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertQuotaAvailable({ ...quota, usedCostCents: 0, unknownCostRuns: 1 }),
    ).not.toThrow();
    expect(() =>
      assertQuotaAvailable({ ...quota, usageComplete: false }),
    ).not.toThrow();
    // Missing cache breakdown does not erase a known total token count.
    expect(() =>
      assertQuotaAvailable({ ...quota, cacheUsageKnown: false }),
    ).not.toThrow();
  });

  it('retains task concurrency and runtime controls independently of token totals', () => {
    const resource = {
      scope: 'user' as const,
      scopeId: randomUUID(),
      monthlyRunLimit: 100,
      monthlyTokenLimit: 10_000,
      concurrentRunLimit: 3,
      maxRuntimeMs: 60_000,
      usedRuns: 10,
      usedTokens: 1_000,
      activeRuns: 2,
    };
    expect(() =>
      assertModelResourceAvailable({
        resources: [resource],
        requestedTokens: 2_000,
        requestedRuntimeMs: 30_000,
      }),
    ).not.toThrow();
    expect(() =>
      assertModelResourceAvailable({
        resources: [{ ...resource, activeRuns: resource.concurrentRunLimit }],
        requestedTokens: 2_000,
        requestedRuntimeMs: 30_000,
      }),
    ).toThrow(
      new ModelGovernanceError('MODEL_RESOURCE_CONCURRENCY_EXCEEDED', 'user'),
    );
    expect(() =>
      assertModelResourceAvailable({
        resources: [resource],
        requestedTokens: 20_000,
        requestedRuntimeMs: 30_000,
      }),
    ).not.toThrow();
    expect(() =>
      assertModelResourceAvailable({
        resources: [resource],
        requestedTokens: 2_000,
        requestedRuntimeMs: 90_000,
      }),
    ).toThrow(new ModelGovernanceError('MODEL_RUNTIME_LIMIT_EXCEEDED', 'user'));
  });
});
