/** Incremental 0096 -> 0097/0098 on an owned PG schema containing old data.
 * Exercises actual SQL and production readers/writers after pool restart.
 * No provider, credentials, running environment, downgrade or model replay.
 * Legacy SQL projections prove column compatibility, NOT old binary safety.
 * Five ordered stages of ONE migration journey: run this entire file without
 * name filtering or shuffle. They are not five independent migrations.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  RouteDecisionSchema,
  resolveAssistantSubscriptionSnapshot,
  type CodexSubscriptionQuotaSnapshot,
} from '@allrice/contracts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { closeDatabase, getDatabase } from './core/client.ts';
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
} from './providers/model-governance.ts';
import {
  getCodexProviderStatus,
  recordCodexProviderStatus,
} from './providers/status.ts';
import { assertSubscriptionQuotaNotExhausted } from '../../../apps/worker/src/subscription-quota-admission.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration('subscription incremental migration and cold SQL readers', () => {
  let fixture: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
  let task: Awaited<ReturnType<typeof fixture.prepareOrdinaryTask>>;
  let decision: ReturnType<typeof RouteDecisionSchema.parse>;
  let subscription: NonNullable<
    ReturnType<typeof resolveAssistantSubscriptionSnapshot>
  >;
  let history: unknown;
  let shadow: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let shadowSchema: string;
  let shadowBefore: unknown;
  let publicBefore: unknown;
  const historicId = randomUUID();
  const migration = (name: string) =>
    readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  const proofInput = (id = decision.id) => ({
    organizationId: fixture.organizationId,
    workspaceId: fixture.workspaceId,
    decisionId: id,
    snapshot: subscription,
  });
  const verifyInput = () => ({
    ...proofInput(),
    runId: task.runId,
  });
  async function ledgerHistory() {
    const [row] = await fixture.db`
      select to_jsonb(d) as route, to_jsonb(l) as ledger
      from allrice_route_decisions d join allrice_model_usage_ledger l
        on l.route_decision_id=d.id where d.id=${historicId}`;
    return row;
  }
  async function restartPool() {
    const old = getDatabase();
    await closeDatabase();
    const fresh = getDatabase();
    expect(fresh).not.toBe(old);
    const [scope] = await fresh`select current_schema() as schema,
      current_schemas(false) as search_path`;
    expect(scope!.schema).toBe(fixture.schema);
    expect(scope!.search_path).toEqual([fixture.schema]);
    return fresh;
  }

  // Only server-side row hashes and relation/column identity leave PostgreSQL.
  // public is observed, never seeded, changed or dropped. The owned shadow
  // supplies deterministic real 0098 tables even on an otherwise empty local DB.
  async function fallbackFingerprint(schema: string) {
    if (schema !== 'public' && !/^p25_[a-f0-9]{32}$/.test(schema))
      throw Error('Unexpected fallback schema');
    const result = [];
    for (const table of [
      'allrice_route_subscription_snapshots',
      'allrice_provider_status',
      'allrice_route_decisions',
      'allrice_model_usage_ledger',
    ]) {
      const [relation] = await shadow.db`select c.oid::text as oid,
        (select jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.attnotnull)
          order by a.attnum) from pg_attribute a
          where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=${schema} and c.relname=${table}
          and c.relkind in ('r','p')`;
      const rows = relation
        ? await shadow.db.unsafe(`select count(*)::int as count,
            encode(sha256(convert_to(coalesce(string_agg(row_hash, '' order by row_hash), ''), 'UTF8')), 'hex') as digest
            from (select encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') as row_hash
              from "${schema}"."${table}" t) rows`)
        : [];
      result.push({ table, relation: relation ?? null, rows: [...rows] });
    }
    return result;
  }

  beforeAll(async () => {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    expect(process.env.DATABASE_URL).toBeUndefined();
    shadow = await createAssistantFixtureDatabase();
    const [shadowScope] = await shadow.db`select current_schema() as schema`;
    shadowSchema = shadowScope!.schema;
    await shadow.db`insert into allrice_provider_status
      (provider,auth_mode,status,detail_code,checked_at,subscription_quota)
      values('codex','chatgpt_subscription','connected',
        'synthetic-ci-fallback-sentinel',now(),'{"sentinel":"must-not-change"}')
      on conflict(provider) do update set status=excluded.status,
        detail_code=excluded.detail_code,checked_at=excluded.checked_at,
        subscription_quota=excluded.subscription_quota`;
    shadowBefore = await fallbackFingerprint(shadowSchema);
    publicBefore = await fallbackFingerprint('public');
    fixture = await createP27CodexWorkerFixture({
      throughMigration: '0096_assistant_pricing.sql',
      allowCiDatabase: true,
    });
    task = await fixture.prepareOrdinaryTask('Migration fixture. No model.');
    const frozen = task.binding.executionSnapshot.modelSnapshot!;
    decision = RouteDecisionSchema.parse({
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
          id: 'direct:migration',
          kind: 'direct',
          name: 'Migration fixture',
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
      selectedCandidateId: 'direct:migration',
      harness: 'dsh',
      provider: 'openai-codex',
      model: frozen.model,
      modelConnectionId: fixture.connectionId,
      modelCatalogEntryId: fixture.catalogId,
      modelPolicyRevision: frozen.policyRevision,
      generation: 1,
      attempt: 2,
      reasonCodes: ['direct_no_capability_match'],
      createdAt: new Date().toISOString(),
    });
    subscription = resolveAssistantSubscriptionSnapshot({
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
    expect(subscription).toBeDefined();
    await recordRouteDecision(
      { ...decision, id: historicId, attempt: 1 },
      fixture.db,
    );
    // Seed the OLD schema, before either additive migration is applied.
    await fixture.db`update allrice_route_decisions set status='succeeded',
      input_tokens=10,output_tokens=2,cost_cents=null,usage_complete=true,
      cache_usage_known=false,completed_at=now() where id=${historicId}`;
    await fixture.db`insert into allrice_model_usage_ledger(
      id,organization_id,workspace_id,route_decision_id,connection_id,
      model_catalog_entry_id,status,input_tokens,cached_input_tokens,output_tokens,
      cost_cents,usage_complete,cache_usage_known,occurred_at)
      values(${randomUUID()},${fixture.organizationId},${fixture.workspaceId},
        ${historicId},${fixture.connectionId},${fixture.catalogId},'succeeded',
        10,0,2,null,true,false,now())`;
    await fixture.db`insert into allrice_provider_status(
      provider,auth_mode,status,cli_version,detail_code,checked_at)
      values('codex','chatgpt_subscription','connected','old-fixture',
        'legacy-status-before-quota',now()-interval '1 minute')
      on conflict(provider) do update set status=excluded.status,
        cli_version=excluded.cli_version,detail_code=excluded.detail_code,
        checked_at=excluded.checked_at`;
    history = await ledgerHistory();
  }, 60_000);

  afterAll(async () => {
    try {
      if (fixture)
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
      try {
        if (shadow)
          expect(await shadow.close()).toMatchObject({
            schemaRemoved: true,
            storageRemoved: true,
            databaseClosed: true,
            adminClosed: true,
          });
      } finally {
        vi.unstubAllEnvs();
      }
    }
  }, 30_000);

  afterEach(async () => {
    if (shadowBefore)
      expect(await fallbackFingerprint(shadowSchema)).toEqual(shadowBefore);
    if (publicBefore)
      expect(await fallbackFingerprint('public')).toEqual(publicBefore);
  });

  it('reproduces fully migrated fallback visibility without borrowing or mutating its tables', async () => {
    await fixture.db.begin(async (tx) => {
      // Read-only recreation of the old path bug, using only an owned shadow
      // instead of adding any table or sentinel to the real public schema.
      await tx`set transaction read only`;
      await tx`select set_config('search_path', ${`${fixture.schema},${shadowSchema},public`}, true)`;
      const [leak] = await tx`select current_schema() as schema,
        to_regclass('allrice_route_subscription_snapshots')::oid =
          to_regclass(${`${shadowSchema}.allrice_route_subscription_snapshots`})::oid as fallback_visible,
        to_regclass(${`${fixture.schema}.allrice_route_subscription_snapshots`}) is null as owned_absent`;
      expect(leak).toEqual({
        schema: fixture.schema,
        fallback_visible: true,
        owned_absent: true,
      });
    });
    for (const db of [fixture.db, getDatabase()]) {
      const [scope] = await db`select current_schemas(false) as search_path,
        to_regclass('allrice_route_subscription_snapshots') is null as proof_absent`;
      expect(scope).toEqual({
        search_path: [fixture.schema],
        proof_absent: true,
      });
    }
  });

  it('rolls back an interrupted expand transaction, then applies both SQL files without rewriting history', async () => {
    const { db } = fixture;
    const assertOldSchema = async () => {
      const [row] = await db`select
        to_regclass(${`${fixture.schema}.allrice_route_subscription_snapshots`}) is null as proof_absent,
        not exists(select 1 from information_schema.columns
          where table_schema=${fixture.schema} and table_name='allrice_provider_status'
          and column_name='subscription_quota') as quota_absent`;
      expect(row).toEqual({ proof_absent: true, quota_absent: true });
    };
    await assertOldSchema();
    const proofSql = await migration('0097_route_subscription_snapshots.sql');
    const quotaSql = await migration('0098_codex_subscription_quota.sql');
    await expect(
      db.begin(async (tx) => {
        await tx.unsafe(proofSql);
        await tx.unsafe(quotaSql);
        throw Error('synthetic_expand_interrupted_before_commit');
      }),
    ).rejects.toThrow('synthetic_expand_interrupted_before_commit');
    await assertOldSchema();
    expect(await ledgerHistory()).toEqual(history);
    await db.begin(async (tx) => {
      await tx.unsafe(proofSql);
      await tx.unsafe(quotaSql);
    });
    expect(await ledgerHistory()).toEqual(history);
    // The current quota reader also requires the additive 0099 review table.
    // Keep the 0097/0098 interruption assertions above, then bring this owned
    // fixture to the reader's schema before testing cold current binaries.
    await db.begin(async (tx) => {
      await tx.unsafe(
        await migration('0099_subscription_usage_budget_reviews.sql'),
      );
    });
    expect(await ledgerHistory()).toEqual(history);
    expect(await getCodexProviderStatus()).toMatchObject({
      status: 'connected',
      detailCode: 'legacy-status-before-quota',
      quota: null,
    });
    expect(
      await getOrganizationModelQuota(fixture.organizationId),
    ).toMatchObject({
      usedTokens: 12,
      subscriptionRuns: 0,
      unknownCostRuns: 1,
      usedCostCents: null,
      usageComplete: true,
      cacheUsageKnown: false,
    });
    await expect(
      freezeRouteSubscriptionSnapshot(proofInput(historicId), db),
    ).rejects.toThrow('FREEZE_TOO_LATE');
  });

  it('persists verified N/A proof across pool restart; current writer rejects mutation or zero-cost completion', async () => {
    await recordRouteDecision(decision, fixture.db);
    const proof = await freezeRouteSubscriptionSnapshot(
      proofInput(),
      fixture.db,
    );
    expect(proof.frozen).toBe(true);
    const before =
      await fixture.db`select * from allrice_route_subscription_snapshots
      where route_decision_id=${decision.id}`;
    const cold = await restartPool();
    expect(await verifyRouteSubscriptionSnapshot(verifyInput(), cold)).toEqual({
      snapshotDigest: proof.snapshotDigest,
    });
    expect(
      await cold`select * from allrice_route_subscription_snapshots
      where route_decision_id=${decision.id}`,
    ).toEqual(before);
    await expect(cold`update allrice_route_subscription_snapshots set snapshot=snapshot
      where route_decision_id=${decision.id}`).rejects.toThrow('IMMUTABLE');
    await expect(cold`delete from allrice_route_subscription_snapshots
      where route_decision_id=${decision.id}`).rejects.toThrow('IMMUTABLE');
    const outcome = {
      decisionId: decision.id,
      status: 'succeeded' as const,
      inputTokens: 30,
      cachedInputTokens: 0,
      outputTokens: 4,
      costCents: null,
      usageComplete: true,
      cacheUsageKnown: false,
      errorCode: null,
      completedAt: new Date().toISOString(),
    };
    await expect(
      completeRouteDecision(
        {
          organizationId: fixture.organizationId,
          workspaceId: fixture.workspaceId,
          outcome: { ...outcome, costCents: 0 },
        },
        cold,
      ),
    ).rejects.toThrow('cannot record a monetary charge');
    await completeRouteDecision(
      {
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        outcome,
      },
      cold,
    );
    const afterRestart = await restartPool();
    expect(
      await getOrganizationModelQuota(fixture.organizationId, afterRestart),
    ).toMatchObject({
      usedTokens: 46,
      usedRuns: 2,
      subscriptionRuns: 1,
      unknownCostRuns: 1,
      usedCostCents: null,
      usageComplete: true,
    });
    const [row] =
      await afterRestart`select d.cost_cents as route_cost,l.cost_cents as ledger_cost,
      s.snapshot_digest from allrice_route_decisions d
      join allrice_model_usage_ledger l on l.route_decision_id=d.id
      join allrice_route_subscription_snapshots s on s.route_decision_id=d.id
      where d.id=${decision.id}`;
    expect(row).toEqual({
      route_cost: null,
      ledger_cost: null,
      snapshot_digest: proof.snapshotDigest,
    });
    // An old projection can read NULL, but cannot distinguish its applicability.
    // Therefore this is not permission to redeploy a pre-0097 Worker.
    const [legacy] =
      await afterRestart`select count(*) filter(where cost_cents is null)::int
      as null_cost_rows from allrice_model_usage_ledger where organization_id=${fixture.organizationId}`;
    expect(legacy!.null_cost_rows).toBe(2);
    expect(await ledgerHistory()).toEqual(history);
  });

  it('retains exhausted quota through cold reads and an old status writer, then fences account changes', async () => {
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms).toISOString();
    const accountA = `sha256:${'a'.repeat(64)}`;
    const accountB = `sha256:${'b'.repeat(64)}`;
    const quota: CodexSubscriptionQuotaSnapshot = {
      source: 'codex_app_server',
      status: 'available',
      checkedAt: at(-3000),
      accountFingerprint: accountA,
      detailCode: 'codex_quota_read',
      buckets: [
        {
          limitId: 'codex',
          limitReached: true,
          windows: [
            {
              slot: 'primary',
              status: 'available',
              usedPercent: 100,
              windowDurationMins: 10080,
              resetsAt: Math.floor(now / 1000) + 3600,
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
    };
    const status = (
      probe: number,
      snapshot: CodexSubscriptionQuotaSnapshot | null,
    ) => ({
      provider: 'codex' as const,
      authMode: 'chatgpt_subscription' as const,
      status: 'connected' as const,
      cliVersion: 'synthetic',
      detailCode: 'migration-read',
      checkedAt: at(probe),
      quota: snapshot,
    });
    await recordCodexProviderStatus(status(-4000, quota));
    const cold = await restartPool();
    const coldStatus = await getCodexProviderStatus();
    expect(coldStatus.quota).toEqual(quota);
    expect(() =>
      assertSubscriptionQuotaNotExhausted(coldStatus.quota, now),
    ).toThrow(
      expect.objectContaining({ code: 'CODEX_SUBSCRIPTION_QUOTA_EXHAUSTED' }),
    );
    // Column-list legacy writes must not clear a stored observation.
    await cold`update allrice_provider_status set detail_code='legacy-status-only',
      checked_at=${new Date(at(-2000))} where provider='codex'`;
    expect((await getCodexProviderStatus()).quota).toEqual(quota);
    await recordCodexProviderStatus(
      status(-1000, {
        source: 'codex_app_server',
        status: 'error',
        checkedAt: at(-500),
        accountFingerprint: null,
        detailCode: 'codex_quota_rpc_failed',
        buckets: [],
      }),
    );
    const failedReadStatus = await getCodexProviderStatus();
    expect(failedReadStatus.quota).toEqual(quota);
    expect(() =>
      assertSubscriptionQuotaNotExhausted(failedReadStatus.quota, now),
    ).toThrow(
      expect.objectContaining({ code: 'CODEX_SUBSCRIPTION_QUOTA_EXHAUSTED' }),
    );
    // Explicitly clearing/rebinding is different from a read error.
    await recordCodexProviderStatus(status(0, null));
    await restartPool();
    expect((await getCodexProviderStatus()).quota).toBeNull();
    await recordCodexProviderStatus(
      status(-1000, { ...quota, checkedAt: at(1000) }),
    );
    expect((await getCodexProviderStatus()).quota).toBeNull();
    const changed = {
      ...quota,
      accountFingerprint: accountB,
      checkedAt: at(2000),
    };
    await recordCodexProviderStatus(status(1000, changed));
    await restartPool();
    expect((await getCodexProviderStatus()).quota).toEqual(changed);
  });

  it('preserves subscription unknown tokens after restart instead of treating N/A as complete usage', async () => {
    const unknownDecision = { ...decision, id: randomUUID(), attempt: 3 };
    await recordRouteDecision(unknownDecision, fixture.db);
    await freezeRouteSubscriptionSnapshot(
      proofInput(unknownDecision.id),
      fixture.db,
    );
    await completeRouteDecision(
      {
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        outcome: {
          decisionId: unknownDecision.id,
          status: 'failed',
          inputTokens: 5,
          cachedInputTokens: 0,
          outputTokens: 0,
          costCents: null,
          usageComplete: false,
          cacheUsageKnown: false,
          errorCode: 'synthetic_usage_unknown',
          completedAt: new Date().toISOString(),
        },
      },
      fixture.db,
    );
    const cold = await restartPool();
    const quota = await getOrganizationModelQuota(fixture.organizationId, cold);
    expect(quota).toMatchObject({
      subscriptionRuns: 2,
      unknownCostRuns: 1,
      usedTokens: 51,
      usageComplete: false,
      cacheUsageKnown: false,
    });
    expect(() => assertQuotaAvailable(quota, 'subscription')).toThrow(
      expect.objectContaining({ code: 'MODEL_TOKEN_USAGE_UNKNOWN' }),
    );
    expect(await ledgerHistory()).toEqual(history);
    const [counts] = await cold`select
      (select count(*)::int from allrice_route_decisions) as decisions,
      (select count(*)::int from allrice_model_usage_ledger) as usage,
      (select count(*)::int from allrice_assistant_price_snapshots) as prices,
      (select count(*)::int from allrice_assistant_cost_receipts) as receipts`;
    expect(counts).toEqual({ decisions: 3, usage: 3, prices: 0, receipts: 0 });
  });
});
