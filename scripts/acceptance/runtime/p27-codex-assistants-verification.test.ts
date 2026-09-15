import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { runtimePolicyDigest } from '../../../packages/database/src/runtime-policy.ts';
import { assertRuntimeFixtureDatabase } from '../../../packages/database/src/runtime-fixture-database.ts';
import { assertQuotaAvailable } from '../../../packages/database/src/providers/model-governance.ts';
import {
  codexSubscriptionAccountingProof,
  readCodexAssistantAdmissions,
  verifyCodexSubscriptionResult,
  type readCodexSubscriptionEvidence,
} from './p27-codex-assistants-verification.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const evidence = {
  snapshotDigest: digest,
  row: {
    input_tokens: 18,
    output_tokens: 7,
    cached_input_tokens: 0,
    cache_usage_known: false,
  },
} as Awaited<ReturnType<typeof readCodexSubscriptionEvidence>>;
const result = () =>
  ({
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    assistantStatus: 'completed',
    usage: { inputTokens: 18, outputTokens: 7, cachedInputTokens: 0 },
    usageComplete: true,
    cacheUsageKnown: false,
    actualCostKnown: false,
    costEstimateAvailable: false,
    estimatedCostCents: null,
    billingMode: 'subscription',
    costBasis: 'not_applicable',
    subscriptionSnapshotDigest: digest,
  }) as unknown as HarnessExecutionResult;
describe('synthetic subscription result assertions, no provider', () => {
  it('requires positive real usage and N/A identity, not a zero tariff', () => {
    expect(
      verifyCodexSubscriptionResult(result(), evidence, true),
    ).toMatchObject({
      billingMode: 'subscription',
      costBasis: 'not_applicable',
      estimatedCostCents: null,
      subscriptionSnapshotDigest: digest,
    });
  });
  it.each([
    { estimatedCostCents: 0 },
    { costBasis: 'unknown' },
    { billingMode: 'token_metered' },
    { subscriptionSnapshotDigest: `sha256:${'b'.repeat(64)}` },
    { usageComplete: false },
    { costEstimateAvailable: true },
    { actualCostKnown: true },
    { cacheUsageKnown: true },
    { costCurrency: 'USD' },
    { priceSnapshotDigest: digest },
    { provider: 'gemini' },
    { usage: { inputTokens: 19, outputTokens: 7, cachedInputTokens: 0 } },
  ])('rejects changed subscription handoff %j', (change) => {
    expect(() =>
      verifyCodexSubscriptionResult(
        { ...result(), ...change } as HarnessExecutionResult,
        evidence,
        true,
      ),
    ).toThrow();
  });
  it('keeps ordinary results distinct from assistant results', () => {
    expect(() =>
      verifyCodexSubscriptionResult(result(), evidence, false),
    ).toThrow();
    expect(
      verifyCodexSubscriptionResult(
        { ...result(), assistantStatus: undefined },
        evidence,
        false,
      ).billingMode,
    ).toBe('subscription');
  });
});

type Admission = Awaited<
  ReturnType<typeof readCodexAssistantAdmissions>
>[number];

/** Synthetic normalization inputs, explicitly not a Worker/model observation or
 * a formal release receipt. PG cases below replace admissions with real rows. */
function syntheticProof(admissions?: Admission[]) {
  const runIds = [randomUUID(), randomUUID(), randomUUID()];
  const calls =
    admissions ??
    runIds.map((runId) => ({
      call_id: randomUUID(),
      run_id: runId,
      request_digest: digest,
      dispatched: true,
      finished: true,
      input_tokens: 10,
      output_tokens: 5,
    }));
  const runs = [...new Set(calls.map((call) => call.run_id))];
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
  const snapshotDigest = runtimePolicyDigest(snapshot);
  const id = randomUUID(),
    organizationId = randomUUID(),
    workspaceId = randomUUID();
  const input = calls.reduce((sum, call) => sum + call.input_tokens, 0);
  const output = calls.reduce((sum, call) => sum + call.output_tokens, 0);
  const observedEvidence = {
    row: {
      id,
      organization_id: organizationId,
      workspace_id: workspaceId,
      run_id: runs[0]!,
      provider: snapshot.provider,
      model: snapshot.model,
      status: 'succeeded',
      employee_id: snapshot.employeeId,
      model_connection_id: snapshot.connectionId,
      model_catalog_entry_id: snapshot.modelCatalogEntryId,
      model_policy_revision: snapshot.policyRevision,
      harness: snapshot.harness,
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: 0,
      cost: null,
      usage_complete: true,
      cache_usage_known: false,
      ledger_input: input,
      ledger_output: output,
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
    },
    snapshot,
    snapshotDigest,
    priceSnapshotCount: 0,
    costReceiptCount: 0,
  };
  const observedResult = {
    ...result(),
    usage: { inputTokens: input, outputTokens: output, cachedInputTokens: 0 },
    subscriptionSnapshotDigest: snapshotDigest,
  };
  const observation: Parameters<typeof codexSubscriptionAccountingProof>[3] = {
    tree: { instances: runs.map((runId) => ({ runId, status: 'completed' })) },
    totals: {
      model_calls: calls.length,
      input_tokens: input,
      output_tokens: output,
    },
    admissions: calls,
    unsettledUsageCount: 0,
  };
  const proof = codexSubscriptionAccountingProof(
    'a'.repeat(40),
    observedResult,
    observedEvidence,
    observation,
  );
  const receiptIdentity = {
    sourceSha: proof.sourceSha,
    runId: proof.runId,
    tenantId: organizationId,
    observedAt: '2026-09-15T00:00:00.000Z',
  };
  return {
    proof,
    receiptIdentity,
    observedEvidence,
    observedResult,
    observation,
  };
}

describe('synthetic accounting proof normalization, not a formal RC receipt', () => {
  it('matches the unchanged strict P28 evidence parser without adding a zero price', async () => {
    const path = '../platform/p28-subscription-evidence.mjs';
    const { validSubscriptionEvidence } = await import(path);
    const { proof, receiptIdentity } = syntheticProof();
    expect(validSubscriptionEvidence(proof, receiptIdentity)).toBe(true);
    expect(proof.route.costCents).toBeNull();
    expect(proof.ledger.costCents).toBeNull();
    expect(proof.result.estimatedCostCents).toBeNull();
    expect(proof.tree.unsettledUsageCount).toBe(0);
    expect(proof.priceSnapshotCount).toBe(0);
    expect(proof.costReceiptCount).toBe(0);
  });

  it.each(['requestDigest', 'inputTokens', 'outputTokens'] as const)(
    'cannot normalize a historical admission missing %s into valid evidence',
    async (field) => {
      const path = '../platform/p28-subscription-evidence.mjs';
      const { validSubscriptionEvidence } = await import(path);
      const { proof, receiptIdentity } = syntheticProof();
      Reflect.deleteProperty(proof.admissions[0]!, field);
      expect(validSubscriptionEvidence(proof, receiptIdentity)).toBe(false);
    },
  );

  it('does not fix observed unknown, mismatched money or run identity for the parser', async () => {
    const path = '../platform/p28-subscription-evidence.mjs';
    const { validSubscriptionEvidence } = await import(path);
    const { receiptIdentity, observedEvidence, observedResult, observation } =
      syntheticProof();
    observedEvidence.row.ledger_workspace_id = randomUUID();
    observedEvidence.row.ledger_complete = false;
    observation.unsettledUsageCount = 1;
    const proof = codexSubscriptionAccountingProof(
      'a'.repeat(40),
      observedResult,
      observedEvidence,
      observation,
    );
    expect(proof.ledger.workspaceId).not.toBe(proof.route.workspaceId);
    expect(proof.ledger.usageComplete).toBe(false);
    expect(proof.tree.unsettledUsageCount).toBe(1);
    expect(validSubscriptionEvidence(proof, receiptIdentity)).toBe(false);
  });
});

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'synthetic admissions exported from isolated real PG, no provider/RC receipt',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      expect(process.env.DATABASE_URL).toBeUndefined();
      assertRuntimeFixtureDatabase(
        new URL(process.env.ALLRICE_TEST_DATABASE_URL ?? 'invalid:'),
      );
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      try {
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

    async function setup(partial = false) {
      const f = await assistantFixture(database.db);
      const children = await Promise.all([f.delegate(), f.delegate()]);
      const runIds = [
        f.task.runId,
        ...children.map((child) => child.instance.runId),
      ];
      const calls = [];
      for (const [index, runId] of runIds.entries()) {
        const callId = randomUUID();
        const requestDigest = `sha256:${String(index + 1).repeat(64)}`;
        const grant = await f.runtime.prepareModelUsage({
          ...f.base,
          runId,
          callId,
          requestedOutputTokens: 200,
        });
        await f.runtime.dispatchModelUsage({
          ...f.base,
          runId,
          callId,
          requestDigest,
          inputTokens: 100,
          outputTokens: grant.outputTokens,
        });
        await f.runtime.settleUsage({
          ...f.base,
          runId,
          callId,
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 10 + index,
            ...(partial && index === 0 ? {} : { output_tokens: 5 + index }),
          },
        });
        calls.push({
          callId,
          runId,
          requestDigest,
          inputTokens: 10 + index,
          outputTokens: 5 + index,
        });
      }
      const identity = {
        db: database.db,
        organizationId: f.task.scope.organizationId,
        workspaceId: f.task.scope.workspaceId,
        ownerId: f.context.actor.id,
      };
      const task = { runId: f.task.runId };
      const expected = {
        runIds,
        modelCalls: 3,
        inputTokens: 33,
        outputTokens: 18,
      };
      return {
        f,
        identity,
        task,
        expected,
        calls,
        read: () => readCodexAssistantAdmissions(identity, task, expected),
      };
    }

    it('exports immutable request identity and SETTLED tokens, never the 100/200 reservation', async () => {
      const { read, calls } = await setup();
      const actual = await read();
      expect(actual).toHaveLength(3);
      for (const call of calls)
        expect(actual.find((row) => row.call_id === call.callId)).toEqual({
          call_id: call.callId,
          run_id: call.runId,
          request_digest: call.requestDigest,
          dispatched: true,
          finished: true,
          input_tokens: call.inputTokens,
          output_tokens: call.outputTokens,
        });
      const path = '../platform/p28-subscription-evidence.mjs';
      const { validSubscriptionEvidence } = await import(path);
      const { proof, receiptIdentity } = syntheticProof(actual);
      expect(validSubscriptionEvidence(proof, receiptIdentity)).toBe(true);
      expect(JSON.stringify(proof.admissions)).not.toContain(
        'synthetic-no-credential',
      );
    });

    it('refuses finished calls whose output settlement is still unknown', async () => {
      const { read, calls } = await setup(true);
      const [row] =
        await database.db`select finished_at from allrice_assistant_model_admissions where call_id=${calls[0]!.callId}`;
      expect(row!.finished_at).not.toBeNull();
      await expect(read()).rejects.toThrow('model_admissions_unverified');
    });

    it.each(['model_calls', 'input_tokens', 'output_tokens'])(
      'refuses missing %s usage instead of inventing zero/observed values',
      async (metric) => {
        const { read, calls } = await setup();
        await database.db`delete from allrice_assistant_usage where call_id=${calls[0]!.callId} and metric=${metric}`;
        await expect(read()).rejects.toThrow('model_admissions_unverified');
      },
    );

    it.each(['organizationId', 'workspaceId', 'ownerId'] as const)(
      'rejects a wrong fixture %s even with matching call IDs',
      async (key) => {
        const { identity, task, expected } = await setup();
        await expect(
          readCodexAssistantAdmissions(
            { ...identity, [key]: randomUUID() },
            task,
            expected,
          ),
        ).rejects.toThrow('model_admissions_unverified');
      },
    );

    it('rejects a settlement from a different child instead of joining only by call ID', async () => {
      const { read, calls } = await setup();
      await database.db`update allrice_assistant_usage set run_id=${calls[1]!.runId} where call_id=${calls[0]!.callId} and metric='input_tokens'`;
      await expect(read()).rejects.toThrow('model_admissions_unverified');
    });

    it('rejects a settlement attached to a different root', async () => {
      const { read, calls } = await setup();
      const other = await assistantFixture(database.db);
      await database.db`update allrice_assistant_usage set root_run_id=${other.task.runId} where call_id=${calls[0]!.callId} and metric='output_tokens'`;
      await expect(read()).rejects.toThrow('model_admissions_unverified');
    });

    it.each(['input_tokens', 'output_tokens'])(
      'rejects unsafe %s bigint instead of rounding evidence',
      async (metric) => {
        const { read, calls } = await setup();
        await database.db`update allrice_assistant_usage set settled_amount=9007199254740992 where call_id=${calls[0]!.callId} and metric=${metric}`;
        await expect(read()).rejects.toThrow('model_admissions_unverified');
      },
    );

    it('requires exactly one actual model call per finished admission', async () => {
      const { read, calls } = await setup();
      await database.db`update allrice_assistant_usage set settled_amount=0 where call_id=${calls[0]!.callId} and metric='model_calls'`;
      await expect(read()).rejects.toThrow('model_admissions_unverified');
    });

    it.each(['inputTokens', 'outputTokens'] as const)(
      'cross-checks %s against the whole-tree/route totals',
      async (metric) => {
        const { identity, task, expected } = await setup();
        await expect(
          readCodexAssistantAdmissions(identity, task, {
            ...expected,
            [metric]: expected[metric] + 1,
          }),
        ).rejects.toThrow('whole_tree_usage');
      },
    );

    it('does not double-count a child to manufacture two child identities', async () => {
      const { identity, task, expected } = await setup();
      expected.runIds[2] = expected.runIds[1]!;
      await expect(
        readCodexAssistantAdmissions(identity, task, expected),
      ).rejects.toThrow('model_admissions_unverified');
    });
  },
);

describe('ordinary follow-up subscription quota semantics, no database or provider', () => {
  const quota = () => ({
    organizationId: '11111111-1111-4111-8111-111111111111',
    monthlyRunLimit: 10,
    monthlyTokenLimit: 1000,
    monthlyCostLimitCents: 0,
    usedRuns: 1,
    usedTokens: 25,
    usedCostCents: 0,
    unknownCostRuns: 0,
    subscriptionRuns: 1,
    usageComplete: true,
    cacheUsageKnown: false,
    periodStart: '2026-09-01T00:00:00.000Z',
  });

  it('admits known subscription tokens even when the cash allowance is zero', () => {
    expect(() => assertQuotaAvailable(quota())).toThrow(
      'MODEL_COST_QUOTA_EXCEEDED',
    );
    expect(() => assertQuotaAvailable(quota(), 'subscription')).not.toThrow();
  });

  it('does not reinterpret historical unknown API cash when admitting subscriptions', () => {
    const mixed = { ...quota(), usedCostCents: null, unknownCostRuns: 1 };
    expect(() => assertQuotaAvailable(mixed)).toThrow(
      'MODEL_COST_USAGE_UNKNOWN',
    );
    expect(() => assertQuotaAvailable(mixed, 'subscription')).not.toThrow();
    expect(mixed).toMatchObject({ usedCostCents: null, unknownCostRuns: 1 });
  });

  it.each([
    [{ usageComplete: false }, 'MODEL_TOKEN_USAGE_UNKNOWN'],
    [{ usedTokens: 1000 }, 'MODEL_TOKEN_QUOTA_EXCEEDED'],
    [{ usedRuns: 10 }, 'MODEL_RUN_QUOTA_EXCEEDED'],
  ])('keeps mandatory internal quota checks %j', (change, code) => {
    expect(() =>
      assertQuotaAvailable({ ...quota(), ...change }, 'subscription'),
    ).toThrow(code);
  });
});
