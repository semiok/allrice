/** Synthetic SQL/storage observations only: no DB, Worker, native or provider.
 * The real validators and frozen subscription schemas remain unmocked. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import { runtimePolicyDigest } from '../../../packages/database/src/runtime-policy.ts';
import type {
  P27CodexWorkerFixture,
  P27PreparedCodexWorkerTask,
} from './p27-codex-worker-fixture.ts';
import {
  P27_CODEX_ORDINARY_SOURCE_FILES,
  verifyCodexOrdinary,
} from './p27-codex-worker-smoke.ts';

const hash = (bytes: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function syntheticFixture() {
  const runIds = [randomUUID()];
  const organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID();
  const snapshot = {
    version: 1,
    billingMode: 'subscription',
    harness: 'dsh',
    provider: 'openai-codex',
    authMode: 'chatgpt_subscription',
    sessionId: randomUUID(),
    employeeId: randomUUID(),
    connectionId: randomUUID(),
    modelCatalogEntryId: randomUUID(),
    policyRevision: 1,
    model: 'gpt-5.6-luna',
    credentialReference: 'synthetic-no-credential',
    baseUrl: null,
    frozenAt: '2026-09-01T00:00:00.000Z',
  } as const;
  const modelSnapshot = {
    schemaVersion: 1,
    sessionId: snapshot.sessionId,
    employeeId: snapshot.employeeId,
    policyRevision: 1,
    connectionId: snapshot.connectionId,
    modelCatalogEntryId: snapshot.modelCatalogEntryId,
    harness: snapshot.harness,
    provider: snapshot.provider,
    authMode: snapshot.authMode,
    model: snapshot.model,
    reasoningEffort: 'low',
    credentialReference: snapshot.credentialReference,
    baseUrl: null,
    fallbackPolicy: 'disabled',
    fallbackTargets: [],
    resolvedFallbacks: [],
    frozenAt: snapshot.frozenAt,
  };
  const task = {
    runId: runIds[0],
    sessionId: snapshot.sessionId,
    binding: {
      executionSnapshot: { modelSnapshot },
      providerSnapshot: {
        provider: 'dsh',
        authMode: 'platform_subscription',
        route: 'openai-codex',
        model: snapshot.model,
        reasoningEffort: 'low',
        credentialReference: snapshot.credentialReference,
        baseUrl: null,
      },
    },
  } as unknown as P27PreparedCodexWorkerTask;
  const id = randomUUID(),
    snapshotDigest = runtimePolicyDigest(snapshot);
  const row = {
    id,
    organization_id: organizationId,
    workspace_id: workspaceId,
    run_id: task.runId,
    provider: snapshot.provider,
    model: snapshot.model,
    harness: snapshot.harness,
    status: 'succeeded',
    employee_id: snapshot.employeeId,
    model_connection_id: snapshot.connectionId,
    model_catalog_entry_id: snapshot.modelCatalogEntryId,
    model_policy_revision: 1,
    input_tokens: 30,
    output_tokens: 15,
    cached_input_tokens: 0,
    cost: null,
    usage_complete: true,
    cache_usage_known: false,
    ledger_input: 30,
    ledger_output: 15,
    ledger_cached: 0,
    ledger_cost: null,
    ledger_complete: true,
    ledger_cache_known: false,
    ledger_status: 'succeeded',
    ledger_route_decision_id: id,
    ledger_organization_id: organizationId,
    ledger_workspace_id: workspaceId,
    snapshot,
    snapshot_digest: snapshotDigest,
  };
  const ordinaryRow = {
    ...row,
    connection_id: snapshot.connectionId,
    auth_mode: snapshot.authMode,
    ledger_input_tokens: 30,
    ledger_output_tokens: 15,
    ledger_cached_input_tokens: 0,
    ledger_cache_usage_known: false,
  };
  const counts = { jobs: 1, runs: 1 };
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('s.snapshot')) return [row];
    if (query.includes('as jobs')) return [counts];
    if (query.includes('p.auth_mode')) return [ordinaryRow];
    throw Error('Unexpected synthetic SQL');
  });
  const fixture = {
    db: sql,
    context: {},
    organizationId,
    workspaceId,
    ownerId,
    employeeId: snapshot.employeeId,
    connectionId: snapshot.connectionId,
    catalogId: snapshot.modelCatalogEntryId,
  } as unknown as P27CodexWorkerFixture;
  const result = {
    provider: snapshot.provider,
    model: snapshot.model,
    answer: '{"sum":579}',
    usage: { inputTokens: 30, outputTokens: 15, cachedInputTokens: 0 },
    usageComplete: true,
    cacheUsageKnown: false,
    actualCostKnown: false,
    costEstimateAvailable: false,
    estimatedCostCents: null,
    billingMode: 'subscription',
    costBasis: 'not_applicable',
    subscriptionSnapshotDigest: snapshotDigest,
  } as HarnessExecutionResult;
  return {
    fixture,
    task,
    row,
    ordinaryRow,
    counts,
    result,
  };
}
let current: ReturnType<typeof syntheticFixture>;
beforeEach(() => {
  current = syntheticFixture();
});
describe('independent ordinary-only verification, no assistant replay', () => {
  it('accepts immutable subscription N/A plus complete usage, not a zero price', async () => {
    const proof = await verifyCodexOrdinary(
      current.fixture,
      current.task,
      current.result,
    );
    expect(proof.accounting).toMatchObject({
      billingMode: 'subscription',
      costBasis: 'not_applicable',
      estimatedCostCents: null,
    });
    expect(proof.subscriptionIdentityAndUsageVerified).toBe(true);
    expect(proof.actualSubscriptionCostKnown).toBe(false);
  });
  const mutations: [string, (state: typeof current) => void][] = [
    [
      'second execution',
      (s) => {
        s.counts.jobs = 2;
        s.counts.runs = 2;
      },
    ],
    [
      'wrong answer',
      (s) => {
        s.result.answer = '{"sum":580}';
      },
    ],
    [
      'API auth',
      (s) => {
        Reflect.set(s.ordinaryRow, 'auth_mode', 'api_key');
      },
    ],
    [
      'zero cost disguised as N/A',
      (s) => {
        s.result.estimatedCostCents = 0;
      },
    ],
    [
      'zero ledger cost disguised as N/A',
      (s) => {
        Reflect.set(s.row, 'cost', '0');
        Reflect.set(s.row, 'ledger_cost', '0');
      },
    ],
    [
      'unknown usage',
      (s) => {
        s.result.usageComplete = false;
      },
    ],
    [
      'ledger drift',
      (s) => {
        s.row.ledger_output++;
      },
    ],
    [
      'foreign subscription',
      (s) => {
        s.row.snapshot_digest = hash('wrong');
      },
    ],
  ];
  it.each(mutations)('rejects %s', async (_name, mutate) => {
    mutate(current);
    await expect(
      verifyCodexOrdinary(current.fixture, current.task, current.result),
    ).rejects.toThrow();
  });
  it('pins existing source files including the complete shared subscription verification path', async () => {
    expect(P27_CODEX_ORDINARY_SOURCE_FILES).toEqual(
      expect.arrayContaining([
        'packages/contracts/src/subscription-snapshot.ts',
        'packages/database/src/execution/route-subscription.ts',
        'packages/database/migrations/0097_route_subscription_snapshots.sql',
        'scripts/acceptance/runtime/p27-subscription-verification.ts',
        'scripts/acceptance/runtime/p27-runtime-preflight.ts',
      ]),
    );
    const root = new URL('../../../', import.meta.url);
    for (const file of P27_CODEX_ORDINARY_SOURCE_FILES)
      expect(hash(await readFile(new URL(file, root)))).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
  });
});
