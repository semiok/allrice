/** Real isolated PostgreSQL only. No provider, credentials, or production rows. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RouteDecisionSchema, RouteOutcomeSchema } from '@allrice/contracts';
import type {
  assistantFixture as AssistantFixture,
  createAssistantFixtureDatabase as CreateFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import {
  completeRouteDecision,
  recordRouteDecision,
} from './execution/route-decision.ts';
import {
  assertQuotaAvailable,
  getOrganizationModelQuota,
} from './providers/model-governance.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type Fixture = Awaited<ReturnType<typeof AssistantFixture>>;
const knownOutcome = (decisionId: string) => ({
  decisionId,
  status: 'succeeded' as const,
  inputTokens: 100,
  cachedInputTokens: 25,
  outputTokens: 20,
  costCents: 2.5,
  errorCode: null,
  failureCategory: null,
  completedAt: new Date().toISOString(),
});

integration('route usage unknown cost and completeness (real PG)', () => {
  let database: Awaited<ReturnType<typeof CreateFixtureDatabase>>;
  let createFixture: typeof AssistantFixture;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const { createAssistantFixtureDatabase, assistantFixture } =
      await import('./assistant-runtime.fixture.ts');
    createFixture = assistantFixture;
    database = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    await database?.close();
    vi.unstubAllEnvs();
  });

  async function fixture() {
    return createFixture(database.db);
  }
  async function route(f: Fixture, attempt = 1) {
    const [employee] = await database.db<{ id: string }[]>`
      select id from allrice_employees where organization_id=${f.task.scope.organizationId}
      and workspace_id=${f.task.scope.workspaceId}`;
    return RouteDecisionSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      runId: f.task.runId,
      organizationId: f.task.scope.organizationId,
      workspaceId: f.task.scope.workspaceId,
      actorId: f.context.actor.id,
      employeeId: employee!.id,
      inputChecksum: `sha256:${'3'.repeat(64)}`,
      candidates: [
        {
          id: 'synthetic-direct',
          kind: 'direct',
          name: 'Synthetic no-provider route',
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
      selectedCandidateId: 'synthetic-direct',
      harness: 'dsh',
      provider: 'synthetic-no-provider',
      model: 'never-called',
      generation: 1,
      attempt,
      reasonCodes: ['direct_no_capability_match'],
      createdAt: new Date().toISOString(),
    });
  }
  async function record(f: Fixture, attempt = 1) {
    return recordRouteDecision(await route(f, attempt), database.db);
  }
  async function complete(
    f: Fixture,
    outcome: Parameters<typeof completeRouteDecision>[0]['outcome'],
  ) {
    await completeRouteDecision(
      {
        organizationId: f.task.scope.organizationId,
        workspaceId: f.task.scope.workspaceId,
        outcome,
      },
      database.db,
    );
  }
  async function persisted(decisionId: string) {
    const [decision] = await database.db<
      {
        cost_cents: string | null;
        cache_usage_known: boolean;
        usage_complete: boolean;
        input_tokens: number;
        cached_input_tokens: number;
        output_tokens: number;
      }[]
    >`select cost_cents,cache_usage_known,usage_complete,input_tokens,cached_input_tokens,output_tokens
      from allrice_route_decisions where id=${decisionId}`;
    const ledger = await database.db<
      {
        id: string;
        cost_cents: string | null;
        cache_usage_known: boolean;
        usage_complete: boolean;
        input_tokens: number;
        cached_input_tokens: number;
        output_tokens: number;
      }[]
    >`select id,cost_cents,cache_usage_known,usage_complete,input_tokens,cached_input_tokens,output_tokens
      from allrice_model_usage_ledger where route_decision_id=${decisionId}`;
    expect(decision).toBeDefined();
    expect(ledger).toHaveLength(1);
    return { decision: decision!, ledger: ledger[0]! };
  }

  it('keeps omitted completeness flags compatible with old known writes and preserves numeric zero', async () => {
    const f = await fixture(),
      decision = await record(f);
    const oldPayload = { ...knownOutcome(decision.id), costCents: 0 };
    expect(oldPayload).not.toHaveProperty('cacheUsageKnown');
    expect(oldPayload).not.toHaveProperty('usageComplete');
    expect(RouteOutcomeSchema.parse(oldPayload)).toMatchObject({
      costCents: 0,
      cacheUsageKnown: true,
      usageComplete: true,
    });
    await complete(f, oldPayload);
    const saved = await persisted(decision.id);
    for (const row of [saved.decision, saved.ledger]) {
      expect(Number(row.cost_cents)).toBe(0);
      expect(row.cost_cents).not.toBeNull();
      expect(row.cache_usage_known).toBe(true);
      expect(row.usage_complete).toBe(true);
    }
    const quota = await getOrganizationModelQuota(
      f.task.scope.organizationId,
      database.db,
    );
    expect(quota).toMatchObject({
      usedRuns: 1,
      usedTokens: 120,
      usedCostCents: 0,
      unknownCostRuns: 0,
      cacheUsageKnown: true,
      usageComplete: true,
    });
    expect(() => assertQuotaAvailable(quota)).not.toThrow();
  });

  it('persists unknown cost as SQL NULL in BOTH tables, never a zero charge', async () => {
    const f = await fixture(),
      decision = await record(f);
    await complete(f, {
      ...knownOutcome(decision.id),
      costCents: null,
      cacheUsageKnown: false,
      usageComplete: false,
    });
    const saved = await persisted(decision.id);
    for (const row of [saved.decision, saved.ledger]) {
      expect(row.cost_cents).toBeNull();
      expect(row.cache_usage_known).toBe(false);
      expect(row.usage_complete).toBe(false);
      expect(row.input_tokens).toBe(100);
      expect(row.output_tokens).toBe(20);
    }
    const quota = await getOrganizationModelQuota(
      f.task.scope.organizationId,
      database.db,
    );
    expect(quota).toMatchObject({
      usedRuns: 1,
      usedTokens: 120,
      usedCostCents: null,
      unknownCostRuns: 1,
      cacheUsageKnown: false,
      usageComplete: false,
    });
    expect(() => assertQuotaAvailable(quota)).toThrow(
      'MODEL_TOKEN_USAGE_UNKNOWN',
    );
  });

  it('known → null and repeated/concurrent retries update one durable ledger row, not duplicate runs or tokens', async () => {
    const f = await fixture(),
      decision = await record(f);
    await complete(f, knownOutcome(decision.id));
    const first = await persisted(decision.id);
    const unknown = {
      ...knownOutcome(decision.id),
      costCents: null,
      cacheUsageKnown: false,
      usageComplete: false,
    };
    await complete(f, unknown);
    await Promise.all([complete(f, unknown), complete(f, unknown)]);
    const after = await persisted(decision.id);
    expect(after.ledger.id).toBe(first.ledger.id);
    expect(after.decision.cost_cents).toBeNull();
    expect(after.ledger.cost_cents).toBeNull();
    const quota = await getOrganizationModelQuota(
      f.task.scope.organizationId,
      database.db,
    );
    expect(quota).toMatchObject({
      usedRuns: 1,
      usedTokens: 120,
      usedCostCents: null,
      unknownCostRuns: 1,
      usageComplete: false,
      cacheUsageKnown: false,
    });
  });

  it('does not let a late legacy zero-cost replay erase previously durable unknown cost/completeness', async () => {
    const f = await fixture(),
      decision = await record(f);
    await complete(f, {
      ...knownOutcome(decision.id),
      costCents: null,
      cacheUsageKnown: false,
      usageComplete: false,
    });
    const before = await persisted(decision.id);
    // An old writer omits flags, which parse to true for first-write backward
    // compatibility. That must not retroactively certify prior unknown usage.
    await expect(
      complete(f, { ...knownOutcome(decision.id), costCents: 0 }),
    ).rejects.toThrow('route decision outcome conflict');
    const after = await persisted(decision.id);
    expect(after.ledger.id).toBe(before.ledger.id);
    for (const row of [after.decision, after.ledger]) {
      expect(row.cost_cents).toBeNull();
      expect(row.cache_usage_known).toBe(false);
      expect(row.usage_complete).toBe(false);
    }
    const quota = await getOrganizationModelQuota(
      f.task.scope.organizationId,
      database.db,
    );
    expect(quota).toMatchObject({
      usedRuns: 1,
      usedTokens: 120,
      usedCostCents: null,
      unknownCostRuns: 1,
      cacheUsageKnown: false,
      usageComplete: false,
    });
    expect(() => assertQuotaAvailable(quota)).toThrow(
      'MODEL_TOKEN_USAGE_UNKNOWN',
    );
  });

  it('keeps NULL cost sticky even when total/cache completeness were already known', async () => {
    const f = await fixture(),
      decision = await record(f);
    await complete(f, { ...knownOutcome(decision.id), costCents: null });
    await expect(
      complete(f, { ...knownOutcome(decision.id), costCents: 0 }),
    ).rejects.toThrow('route decision outcome conflict');
    const saved = await persisted(decision.id);
    expect(saved.decision.cost_cents).toBeNull();
    expect(saved.ledger.cost_cents).toBeNull();
    const quota = await getOrganizationModelQuota(
      f.task.scope.organizationId,
      database.db,
    );
    expect(quota).toMatchObject({
      usedCostCents: null,
      unknownCostRuns: 1,
      cacheUsageKnown: true,
      usageComplete: true,
    });
    expect(() => assertQuotaAvailable(quota)).toThrow(
      'MODEL_COST_USAGE_UNKNOWN',
    );
  });

  it.each(['cacheUsageKnown', 'usageComplete'] as const)(
    'does not certify %s=false through an omitted-flag legacy replay',
    async (flag) => {
      const f = await fixture(),
        decision = await record(f);
      await complete(f, { ...knownOutcome(decision.id), [flag]: false });
      const before = await persisted(decision.id);
      await expect(complete(f, knownOutcome(decision.id))).rejects.toThrow(
        'route decision outcome conflict',
      );
      const after = await persisted(decision.id);
      expect(after).toEqual(before);
      const quota = await getOrganizationModelQuota(
        f.task.scope.organizationId,
        database.db,
      );
      expect(quota[flag]).toBe(false);
      if (flag === 'usageComplete')
        expect(() => assertQuotaAvailable(quota)).toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
    },
  );

  it.each([
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'costCents',
  ] as const)(
    'does not let a same-terminal replay reduce already durable %s',
    async (metric) => {
      const f = await fixture(),
        decision = await record(f);
      await complete(f, knownOutcome(decision.id));
      const before = await persisted(decision.id);
      await expect(
        complete(f, { ...knownOutcome(decision.id), [metric]: 0 }),
      ).rejects.toThrow('route decision outcome conflict');
      expect(await persisted(decision.id)).toEqual(before);
      expect(
        await getOrganizationModelQuota(
          f.task.scope.organizationId,
          database.db,
        ),
      ).toMatchObject({
        usedRuns: 1,
        usedTokens: 120,
        usedCostCents: 2.5,
        unknownCostRuns: 0,
      });
    },
  );

  it('cannot move an existing unknown charge out of this month via a late completedAt', async () => {
    const f = await fixture(),
      decision = await record(f);
    const outcome = {
      ...knownOutcome(decision.id),
      costCents: null,
      cacheUsageKnown: false,
      usageComplete: false,
    };
    await complete(f, outcome);
    const timestamps = () => database.db<
      { completed_at: Date; occurred_at: Date }[]
    >`
      select d.completed_at,l.occurred_at from allrice_route_decisions d
      join allrice_model_usage_ledger l on l.route_decision_id=d.id where d.id=${decision.id}`;
    const before = await timestamps();
    const [clock] = await database.db<
      { old: Date }[]
    >`select date_trunc('month',now())-interval '1 day' as old`;
    await complete(f, {
      ...outcome,
      completedAt: clock!.old.toISOString(),
    });
    expect(await timestamps()).toEqual(before);
    const quota = await getOrganizationModelQuota(
      f.task.scope.organizationId,
      database.db,
    );
    expect(quota).toMatchObject({
      usedRuns: 1,
      usedTokens: 120,
      usedCostCents: null,
      unknownCostRuns: 1,
      cacheUsageKnown: false,
      usageComplete: false,
    });
    expect(() => assertQuotaAvailable(quota)).toThrow(
      'MODEL_TOKEN_USAGE_UNKNOWN',
    );
  });

  it('rejects cross-organization and same-organization cross-workspace completion without corrupting either bill', async () => {
    const f = await fixture(),
      other = await fixture(),
      decision = await record(f);
    await complete(f, knownOutcome(decision.id));
    const before = await persisted(decision.id);
    await expect(
      complete(other, { ...knownOutcome(decision.id), costCents: null }),
    ).rejects.toThrow('route decision outcome was not accepted');
    const foreignWorkspace = randomUUID();
    await database.db`insert into allrice_workspaces(id,organization_id,slug,name)
      values(${foreignWorkspace},${f.task.scope.organizationId},'other','Synthetic other workspace')`;
    await expect(
      completeRouteDecision(
        {
          organizationId: f.task.scope.organizationId,
          workspaceId: foreignWorkspace,
          outcome: { ...knownOutcome(decision.id), costCents: null },
        },
        database.db,
      ),
    ).rejects.toThrow('route decision outcome was not accepted');
    expect(await persisted(decision.id)).toEqual(before);
    expect(
      await getOrganizationModelQuota(
        other.task.scope.organizationId,
        database.db,
      ),
    ).toMatchObject({
      usedRuns: 0,
      usedTokens: 0,
      usedCostCents: 0,
      unknownCostRuns: 0,
      usageComplete: true,
      cacheUsageKnown: true,
    });
  });

  it('rejects a forged cross-tenant route at admission and keeps same-run replay scoped', async () => {
    const f = await fixture(),
      other = await fixture();
    const candidate = await route(f);
    const recorded = await recordRouteDecision(candidate, database.db);
    expect(
      (
        await recordRouteDecision(
          { ...candidate, id: randomUUID() },
          database.db,
        )
      ).id,
    ).toBe(recorded.id);
    await expect(
      recordRouteDecision(
        {
          ...candidate,
          id: randomUUID(),
          organizationId: other.task.scope.organizationId,
          workspaceId: other.task.scope.workspaceId,
          actorId: other.context.actor.id,
        },
        database.db,
      ),
    ).rejects.toThrow();
    const rows =
      await database.db`select id from allrice_route_decisions where run_id=${f.task.runId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(recorded.id);
  });

  it('aggregates known plus unknown charges as unknown and isolates other organizations', async () => {
    const f = await fixture(),
      other = await fixture();
    const known = await record(f),
      unknown = await record(f, 2),
      unrelated = await record(other);
    await complete(f, knownOutcome(known.id));
    await complete(f, {
      ...knownOutcome(unknown.id),
      inputTokens: 200,
      outputTokens: 30,
      costCents: null,
    });
    await complete(other, { ...knownOutcome(unrelated.id), costCents: 7 });
    const quota = await getOrganizationModelQuota(
      f.task.scope.organizationId,
      database.db,
    );
    expect(quota).toMatchObject({
      usedRuns: 2,
      usedTokens: 350,
      usedCostCents: null,
      unknownCostRuns: 1,
      usageComplete: true,
      cacheUsageKnown: true,
    });
    expect(() => assertQuotaAvailable(quota)).toThrow(
      'MODEL_COST_USAGE_UNKNOWN',
    );
    const otherQuota = await getOrganizationModelQuota(
      other.task.scope.organizationId,
      database.db,
    );
    expect(otherQuota).toMatchObject({
      usedRuns: 1,
      usedTokens: 120,
      usedCostCents: 7,
      unknownCostRuns: 0,
      usageComplete: true,
      cacheUsageKnown: true,
    });
    expect(() => assertQuotaAvailable(otherQuota)).not.toThrow();
  });

  it('fails closed for incomplete total usage even when recorded cost is numeric', async () => {
    const f = await fixture(),
      decision = await record(f);
    await complete(f, { ...knownOutcome(decision.id), usageComplete: false });
    const quota = await getOrganizationModelQuota(
      f.task.scope.organizationId,
      database.db,
    );
    expect(quota.usageComplete).toBe(false);
    expect(quota.unknownCostRuns).toBe(0);
    expect(() => assertQuotaAvailable(quota)).toThrow(
      'MODEL_TOKEN_USAGE_UNKNOWN',
    );
  });

  it('preserves unknown cache breakdown independently of known total input and an explicitly supplied cost', async () => {
    const f = await fixture(),
      decision = await record(f);
    await complete(f, {
      ...knownOutcome(decision.id),
      cachedInputTokens: 0,
      cacheUsageKnown: false,
    });
    const quota = await getOrganizationModelQuota(
      f.task.scope.organizationId,
      database.db,
    );
    expect(quota).toMatchObject({
      usedTokens: 120,
      usedCostCents: 2.5,
      unknownCostRuns: 0,
      usageComplete: true,
      cacheUsageKnown: false,
    });
    const saved = await persisted(decision.id);
    for (const row of [saved.decision, saved.ledger]) {
      expect(row.cached_input_tokens).toBe(0);
      expect(row.cache_usage_known).toBe(false); // Numeric placeholder is NOT proof of zero cache.
    }
    expect(() => assertQuotaAvailable(quota)).not.toThrow();
  });

  it('excludes prior-month unknown cost from the current quota window without rewriting history', async () => {
    const f = await fixture(),
      old = await record(f),
      current = await record(f, 2);
    const [clock] = await database.db<
      { old: Date }[]
    >`select date_trunc('month',now())-interval '1 day' as old`;
    await complete(f, {
      ...knownOutcome(old.id),
      costCents: null,
      cacheUsageKnown: false,
      usageComplete: false,
      completedAt: clock!.old.toISOString(),
    });
    await complete(f, knownOutcome(current.id));
    const quota = await getOrganizationModelQuota(
      f.task.scope.organizationId,
      database.db,
    );
    expect(quota).toMatchObject({
      usedRuns: 1,
      usedTokens: 120,
      usedCostCents: 2.5,
      unknownCostRuns: 0,
      usageComplete: true,
      cacheUsageKnown: true,
    });
    expect((await persisted(old.id)).ledger.cost_cents).toBeNull();
    expect(() => assertQuotaAvailable(quota)).not.toThrow();
  });
});
