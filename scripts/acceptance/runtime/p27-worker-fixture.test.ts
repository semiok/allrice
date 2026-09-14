/** Real production preparation + isolated PostgreSQL, never provider execution.
 * The one terminal-accounting seed below is explicitly synthetic, not a claim
 * that an assistant/native/model task has executed successfully. */
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type Postgres from '../../../packages/database/node_modules/postgres/types/index.d.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Database from '../../../packages/database/src/index.ts';
import type * as Router from '../../../apps/worker/src/harness/router.ts';
import type { RouteDecision } from '../../../packages/contracts/src/index.ts';
import { createP27GeminiPriceBinding } from './p27-assistant-pricing.ts';
import {
  createP27WorkerFixture,
  P27WorkerFixtureError,
  type P27PreparedWorkerTask,
  type P27WorkerFixture,
} from './p27-worker-fixture.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration('P27 production Worker fixture preparation (no provider)', () => {
  let fixture: P27WorkerFixture;
  let first: P27PreparedWorkerTask;
  let api: typeof Database;
  let router: typeof Router;
  let preparedDecision: RouteDecision;
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    // A missing/rejected precondition must not silently choose a deployment DB.
    vi.stubEnv('DATABASE_URL', 'postgres://forbidden.invalid/prod');
    await expect(createP27WorkerFixture()).rejects.toMatchObject({
      code: 'P27_WORKER_AMBIENT_DATABASE',
    });
    vi.stubEnv('DATABASE_URL', undefined);
    fixture = await createP27WorkerFixture();
    api = await import('../../../packages/database/src/index.ts');
    router = await import('../../../apps/worker/src/harness/router.ts');
  }, 30000);
  afterAll(async () => {
    await router?.closeHarnessAdapters();
    if (fixture) {
      const proof = await fixture.close();
      expect(proof).toMatchObject({
        globalDatabaseClosed: true,
        databaseEnvironmentRestored: true,
        fixture: {
          schemaRemoved: true,
          storageRemoved: true,
          databaseClosed: true,
          adminClosed: true,
        },
      });
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(await fixture.close()).toEqual(proof);
      await expect(fixture.db`select 1`).rejects.toBeDefined();
    }
    vi.unstubAllEnvs();
  });

  it('binds the actual global pool to the generated migrated schema without pre-seeded work', async () => {
    const [identity] = await api.getDatabase()<
      { schema: string; database: string }[]
    >`
      select current_schema() as schema,current_database() as database`;
    expect(identity).toEqual({
      schema: fixture.schema,
      database: 'allrice_b2',
    });
    expect(fixture.schema).toMatch(/^p25_[a-f0-9]{32}$/);
    const [counts] = await fixture.db`select
      (select count(*)::int from allrice_runs) as runs,
      (select count(*)::int from allrice_jobs) as jobs,
      (select count(*)::int from allrice_session_model_snapshots) as snapshots,
      (select count(*)::int from allrice_assistant_instances) as assistants`;
    expect(counts).toEqual({ runs: 0, jobs: 0, snapshots: 0, assistants: 0 });
    await expect(createP27WorkerFixture()).rejects.toMatchObject({
      code: 'P27_WORKER_FIXTURE_ALREADY_OWNED',
    });
    await expect(
      fixture.prepareOrdinaryTask({
        afterRunId: randomUUID(),
        prompt: 'ordinary',
      }),
    ).rejects.toMatchObject({ code: 'P27_WORKER_FIRST_RUN_MISMATCH' });
  });

  it('prepares, freezes, enqueues and leases the first task through production APIs', async () => {
    first = await fixture.prepareAssistantTask(
      'Synthetic parent: delegate two small arithmetic reports. Do not call external tools.',
    );
    const resolved = await api.resolveEmployeeExecution({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      ownerId: fixture.ownerId,
      runId: first.runId,
    });
    expect(resolved.promptSnapshot.userRequest).toContain('delegate two');
    expect(
      resolved.executionSnapshot?.schemaVersion === 2
        ? resolved.executionSnapshot.modelSnapshot
        : null,
    ).toMatchObject({
      sessionId: first.sessionId,
      employeeId: fixture.employeeId,
      connectionId: fixture.connectionId,
      modelCatalogEntryId: fixture.catalogId,
      provider: 'gemini',
      authMode: 'api_key',
      model: 'gemini-3.8-flash',
      fallbackPolicy: 'disabled',
      resolvedFallbacks: [],
      runLimits: fixture.runLimits,
    });
    expect(first.execution.payload.input).toMatchObject({
      employeeAssignmentId: fixture.assignmentId,
      employeeVersionId: fixture.employeeVersionId,
      sessionId: first.sessionId,
      userMessageId: first.userMessageId,
      assistantMessageId: first.assistantMessageId,
      assistantConfiguration: {
        allowAssistants: true,
        maxConcurrent: 2,
        maxChildren: 2,
        maxDepth: 1,
      },
    });
    expect(first.execution.context).toMatchObject({
      runId: first.runId,
      jobId: first.workflowLease.jobId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
    });
    const [job] =
      await fixture.db`select status,attempt,max_attempts,lease_token,worker_id,
      lease_expires_at>clock_timestamp() as live from allrice_jobs where id=${first.workflowLease.jobId}`;
    expect(job).toEqual({
      status: 'running',
      attempt: 1,
      max_attempts: 1,
      lease_token: first.workflowLease.leaseToken,
      worker_id: first.workflowLease.workerId,
      live: true,
    });
    expect(
      router.getHarnessRouter().select({
        runtimePolicy: resolved.executionSnapshot!.runtimePolicy,
        providerSnapshot: resolved.providerSnapshot,
        allowRuntimePolicyFallbacks: false,
      }).providerSnapshot,
    ).toEqual(resolved.providerSnapshot);
    expect(router.getHarnessRouter().runtimeInventory()).toEqual([]);
    await expect(
      fixture.prepareAssistantTask('not a retry'),
    ).rejects.toMatchObject({ code: 'P27_WORKER_FIRST_ALREADY_ATTEMPTED' });
  });

  it('uses a real persisted model snapshot and source price selector before any model admission', async () => {
    const snapshot = first.binding.executionSnapshot.modelSnapshot!;
    const frozen = await api.freezeSessionModelSnapshot({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      sessionId: first.sessionId,
    });
    expect(frozen).toEqual(snapshot);
    const { preflightAssistantPricing } =
      await import('../../../apps/worker/src/assistant-pricing-preflight.ts');
    vi.stubEnv(
      'ALLRICE_ASSISTANT_PRICING_JSON',
      JSON.stringify(fixture.pricingCatalog),
    );
    vi.stubEnv('ALLRICE_ASSISTANT_PRICING_CURRENCY', 'USD');
    const { RouteDecisionSchema } =
      await import('../../../packages/contracts/src/index.ts');
    const decision = RouteDecisionSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      runId: first.runId,
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      actorId: fixture.ownerId,
      employeeId: fixture.employeeId,
      inputChecksum: `sha256:${'a'.repeat(64)}`,
      candidates: [
        {
          id: 'direct:fixture',
          kind: 'direct',
          name: 'Synthetic preparation',
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
      selectedCandidateId: 'direct:fixture',
      harness: 'dsh',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      modelConnectionId: fixture.connectionId,
      modelCatalogEntryId: fixture.catalogId,
      modelPolicyRevision: snapshot.policyRevision,
      fallbackFromDecisionId: null,
      fallbackCondition: null,
      generation: 1,
      attempt: 1,
      reasonCodes: ['direct_no_capability_match'],
      createdAt: new Date().toISOString(),
    });
    preparedDecision = decision;
    const input = {
      enabled: true,
      sessionId: first.sessionId,
      deadlineAt: first.execution.job.timeoutAt,
      modelSnapshot: snapshot,
      decision,
      providerSnapshot: first.binding.providerSnapshot,
      hasNonTextInput: false,
    };
    expect(preflightAssistantPricing(input)?.price).toEqual(
      fixture.pricingCatalog.entries[0],
    );
    await expect(
      Promise.resolve().then(() =>
        preflightAssistantPricing({
          ...input,
          decision: { ...decision, modelConnectionId: randomUUID() },
        }),
      ),
    ).rejects.toMatchObject({ code: 'ASSISTANT_PRICE_ROUTE_UNVERIFIED' });
    const [counts] = await fixture.db`select
      (select count(*)::int from allrice_assistant_model_admissions) as admissions,
      (select count(*)::int from allrice_assistant_price_snapshots) as prices,
      (select count(*)::int from allrice_route_decisions) as routes`;
    expect(counts).toEqual({ admissions: 0, prices: 0, routes: 0 });
  });

  it('refuses cross-tenant resolution, wrong leases, and premature ordinary preparation', async () => {
    await expect(
      api.resolveEmployeeExecution({
        organizationId: randomUUID(),
        workspaceId: fixture.workspaceId,
        ownerId: fixture.ownerId,
        runId: first.runId,
      }),
    ).rejects.toBeDefined();
    await expect(
      api.heartbeatJob(
        first.workflowLease.workerId,
        first.workflowLease.jobId,
        randomUUID(),
        30000,
      ),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await expect(
      api.startClaimedJob(
        first.workflowLease.workerId,
        first.workflowLease.jobId,
        first.workflowLease.leaseToken,
      ),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await expect(
      fixture.prepareOrdinaryTask({
        afterRunId: first.runId,
        prompt: 'ordinary',
      }),
    ).rejects.toMatchObject({ code: 'P27_WORKER_FIRST_NOT_VERIFIED' });
    expect(
      (
        await api.heartbeatJob(
          first.workflowLease.workerId,
          first.workflowLease.jobId,
          first.workflowLease.leaseToken,
          30000,
        )
      ).active,
    ).toBe(true);
  });

  it('keeps the existing frozen selection when the current policy changes and rejects an unregistered target', async () => {
    const policy = {
      connectionId: fixture.connectionId,
      modelCatalogEntryId: fixture.catalogId,
      reasoningEffort: 'high',
      fallbackPolicy: 'disabled',
      fallbackTargets: [],
      fallbackOn: [],
      runLimits: fixture.runLimits,
    };
    const input = {
      context: fixture.context,
      workspaceId: fixture.workspaceId,
      employeeId: fixture.employeeId,
    };
    await expect(
      api.upsertEmployeeModelPolicy({
        ...input,
        policy: { ...policy, connectionId: randomUUID() },
      }),
    ).rejects.toBeDefined();
    await api.upsertEmployeeModelPolicy({ ...input, policy });
    const snapshot = await api.freezeSessionModelSnapshot({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      sessionId: first.sessionId,
    });
    expect(snapshot).toEqual(first.binding.executionSnapshot.modelSnapshot);
    expect(snapshot.reasoningEffort).toBe('low');
    await api.upsertEmployeeModelPolicy({
      ...input,
      policy: { ...policy, reasoningEffort: 'low' },
    });
    await expect(
      api.admitModelExecution({
        organizationId: fixture.organizationId,
        workspaceId: fixture.workspaceId,
        userId: fixture.ownerId,
        employeeId: fixture.employeeId,
        connectionId: fixture.connectionId,
        requestedTokens: fixture.runLimits.maxTotalTokens,
        requestedRuntimeMs: fixture.runLimits.timeoutMs,
      }),
    ).resolves.toHaveLength(4);
    expect(router.getHarnessRouter().runtimeInventory()).toEqual([]);
  });

  it('does not manufacture ordinary eligibility from a merely terminal Run without cost evidence', async () => {
    await api.completeJob({
      ...first.workflowLease,
      result: { syntheticPreparationOnly: true, providerCalled: false },
    });
    await expect(
      fixture.prepareOrdinaryTask({
        afterRunId: first.runId,
        prompt: 'ordinary',
      }),
    ).rejects.toMatchObject({ code: 'P27_WORKER_FIRST_NOT_VERIFIED' });
    const [rows] =
      await fixture.db`select count(*)::int as count from allrice_jobs`;
    expect(rows?.count).toBe(1);
    expect(router.getHarnessRouter().runtimeInventory()).toEqual([]);
  });

  it('prepares a separate ordinary lease only after synthetic terminal accounting satisfies the gate (not model execution)', async () => {
    // Exercise the preparation gate with explicit synthetic accounting through
    // the real writer. This is NOT native/provider/assistant success evidence.
    await api.recordRouteDecision(preparedDecision);
    await api.completeRouteDecision({
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      outcome: {
        decisionId: preparedDecision.id,
        status: 'succeeded',
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        costCents: 1,
        usageComplete: true,
        cacheUsageKnown: false,
        errorCode: null,
        failureCategory: null,
        completedAt: new Date().toISOString(),
      },
    });
    const preparingOrdinary = fixture.prepareOrdinaryTask({
      afterRunId: first.runId,
      prompt: 'Synthetic ordinary: return the number 2. No tools.',
    });
    await expect(
      fixture.prepareOrdinaryTask({
        afterRunId: first.runId,
        prompt: 'concurrent duplicate',
      }),
    ).rejects.toMatchObject({ code: 'P27_WORKER_ORDINARY_NOT_IDLE' });
    const ordinary = await preparingOrdinary;
    expect(ordinary.sessionId).not.toBe(first.sessionId);
    expect(ordinary.execution.context.organizationId).toBe(
      fixture.organizationId,
    );
    expect(ordinary.execution.payload.input).toMatchObject({
      assistantConfiguration: { allowAssistants: false },
    });
    expect(ordinary.binding.executionSnapshot.modelSnapshot).toMatchObject({
      connectionId: fixture.connectionId,
      modelCatalogEntryId: fixture.catalogId,
    });
    const quota = await api.getOrganizationModelQuota(fixture.organizationId);
    expect(quota).toMatchObject({
      usedRuns: 1,
      usedTokens: 15,
      usedCostCents: 1,
      unknownCostRuns: 0,
      usageComplete: true,
      cacheUsageKnown: false,
    });
    expect(() => api.assertQuotaAvailable(quota)).not.toThrow();
    expect(router.getHarnessRouter().runtimeInventory()).toEqual([]);
    await expect(
      fixture.prepareOrdinaryTask({
        afterRunId: first.runId,
        prompt: 'not a retry',
      }),
    ).rejects.toMatchObject({ code: 'P27_WORKER_ORDINARY_NOT_IDLE' });
  });
});

integration('P27 Worker fixture initialization cleanup (no provider)', () => {
  afterAll(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('preserves the original post-initialization error code and actual cleanup proof', async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.ALLRICE_TEST_DATABASE_URL).toBe(
      'postgres://a123@127.0.0.1:5432/allrice_b2',
    );
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const module =
      await import('../../../packages/database/src/assistant-runtime.fixture.ts');
    const createRealFixture = module.createAssistantFixtureDatabase;
    let created: Awaited<ReturnType<typeof createRealFixture>> | undefined;
    vi.spyOn(module, 'createAssistantFixtureDatabase').mockImplementationOnce(
      async () => {
        created = await createRealFixture();
        // The fault is confined to this freshly generated test schema. All
        // preparation and disposal still use real production pools and SQL.
        await created.db`update allrice_model_catalog_entries
          set model='p27-missing-gemini' where model='gemini-3.8-flash'`;
        return created;
      },
    );
    let error: unknown;
    try {
      await createP27WorkerFixture();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(P27WorkerFixtureError);
    const failure = error as P27WorkerFixtureError;
    expect(failure).toMatchObject({
      code: 'P27_WORKER_GEMINI_CATALOG_MISSING',
      cleanup: {
        globalDatabaseClosed: true,
        databaseEnvironmentRestored: true,
        fixture: {
          schemaRemoved: true,
          storageRemoved: true,
          databaseClosed: true,
          adminClosed: true,
        },
      },
    });
    const proof = failure.cleanup!.fixture!;
    expect(proof.schema).toMatch(/^p25_[a-f0-9]{32}$/);
    expect(process.env.DATABASE_URL).toBeUndefined();
    await expect(created!.db`select 1`).rejects.toBeDefined();
    expect(proof.storageRoot).not.toBeNull();
    await expect(lstat(proof.storageRoot!)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const postgres = createRequire(
      new URL('../../../packages/database/package.json', import.meta.url),
    )('postgres') as typeof Postgres;
    const inspector = postgres(process.env.ALLRICE_TEST_DATABASE_URL!, {
      max: 1,
      connect_timeout: 5,
      onnotice: () => {},
    });
    try {
      const [row] = await inspector<{ absent: boolean }[]>`
        select to_regnamespace(${proof.schema}) is null as absent`;
      expect(row?.absent).toBe(true);
    } finally {
      await inspector.end({ timeout: 5 });
    }
  }, 30000);
});

integration(
  'P27 real Worker lease to controller pricing (no native/provider)',
  () => {
    it('binds the full production workflow lease without forwarding scheduling metadata to strict pricing identity', async () => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      let fixture: P27WorkerFixture | undefined;
      try {
        fixture = await createP27WorkerFixture();
        const task = await fixture.prepareAssistantTask(
          'Synthetic controller bind only.',
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
        const taskInput = task.execution.payload.input;
        if (
          !taskInput ||
          typeof taskInput !== 'object' ||
          !('assistantConfiguration' in taskInput)
        )
          throw Error('P27_TEST_ASSISTANT_CONFIGURATION_MISSING');
        const common = {
          configuration: taskInput.assistantConfiguration,
          context: task.execution.context,
          runLimits: fixture.runLimits,
          tools: [{ name: 'assistant.delegate' }, { name: 'assistant.report' }],
          authorize: api.assertAssistantAuthority,
          database: fixture.db,
          priceSnapshot: snapshot,
        };
        expect(task.workflowLease.leaseMs).toBe(30000);
        const withWorkflowLease = productionAssistantController({
          ...common,
          worker: task.workflowLease,
        })!;
        // Before the fix, this exact real-PG bind rejected leaseMs at the
        // strict pricing boundary after root creation but before admission.
        const bound = await withWorkflowLease.bind(
          nativeSessionId,
          runtime.generation,
        );
        expect(bound).toBeDefined();
        const [before] = await fixture.db`select
        (select count(*)::int from allrice_runtime_roots) as runtime_roots,
        (select count(*)::int from allrice_assistant_roots) as assistant_roots,
        (select count(*)::int from allrice_assistant_model_admissions) as admissions,
        (select count(*)::int from allrice_assistant_usage) as usage,
        (select count(*)::int from allrice_assistant_price_snapshots) as prices`;
        expect(before).toEqual({
          runtime_roots: 1,
          assistant_roots: 1,
          admissions: 0,
          usage: 0,
          prices: 1,
        });
        // The DB API remains strict; fixing the caller is not permission to
        // accept arbitrary worker metadata or weaken its lease checks.
        await expect(
          api.createAssistantPricing({ database: fixture.db }).freeze({
            scope: {
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
              projectId: null,
            },
            rootRunId: task.runId,
            worker: { ...task.workflowLease, generation: runtime.generation },
            snapshot,
          }),
        ).rejects.toMatchObject({
          name: 'ZodError',
          issues: [{ code: 'unrecognized_keys', keys: ['leaseMs'], path: [] }],
        });
        const [after] = await fixture.db`select
        (select count(*)::int from allrice_assistant_model_admissions) as admissions,
        (select count(*)::int from allrice_assistant_usage) as usage,
        (select count(*)::int from allrice_assistant_price_snapshots) as prices`;
        expect(after).toEqual({ admissions: 0, usage: 0, prices: 1 });
      } finally {
        await fixture?.close();
        vi.unstubAllEnvs();
      }
    }, 30000);
  },
);
