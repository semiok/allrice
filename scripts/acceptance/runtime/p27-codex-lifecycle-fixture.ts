/** Synthetic lifecycle acceptance only. Real subscription proof/controller/PG and
 * pinned governed native runtime; loopback OpenAI-compatible transport is NOT a
 * Codex provider, Worker dispatch, account balance, or remote cancellation proof. */
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RouteDecisionSchema,
  DshExecutionSnapshotSchema,
  SessionModelSnapshotSchema,
  resolveAssistantSubscriptionSnapshot,
  type SessionModelSnapshot,
  type ExecutionContext,
} from '../../../packages/contracts/src/index.ts';
import { createAssistantAuthorityFixture } from '../../../packages/database/src/assistant-authority.fixture.ts';
import { assertAssistantAuthority } from '../../../packages/database/src/assistant-authority.ts';
import type { createAssistantFixtureDatabase } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { assertRuntimeFixtureDatabase } from '../../../packages/database/src/runtime-fixture-database.ts';
import {
  recordRouteDecision,
  completeRouteDecision,
} from '../../../packages/database/src/execution/route-decision.ts';
import { freezeRouteSubscriptionSnapshot } from '../../../packages/database/src/execution/route-subscription.ts';
import { LocalStorageAdapter } from '../../../packages/storage/src/index.ts';
import { productionAssistantController } from '../../../apps/worker/src/harness/dsh/assistant-controller.ts';
import { gate, p24Fixture } from '../../../apps/worker/test/p24/fixture.ts';

export type CodexLifecycleMode =
  'completed' | 'partial_failure' | 'unknown_usage' | 'over_budget';
type Database = Awaited<
  ReturnType<typeof createAssistantFixtureDatabase>
>['db'];

export async function createCodexLifecycleScenario(
  db: Database,
  options: {
    mode?: CodexLifecycleMode;
    /** Deliberately lose checkpoint ACK after actual native journal flush. */
    loseCheckpointAck?: boolean;
  } = {},
) {
  const fixtureUrl = new URL(
    process.env.ALLRICE_TEST_DATABASE_URL ?? 'invalid:',
  );
  assertRuntimeFixtureDatabase(fixtureUrl);
  const [scope] = await db<
    { schema: string; database: string }[]
  >`select current_schema() as schema,current_database() as database`;
  if (
    scope?.database !== fixtureUrl.pathname.slice(1) ||
    !/^p25_[a-f0-9]{32}$/.test(scope.schema)
  )
    throw Error('lifecycle_requires_owned_uuid_test_schema');
  const mode = options.mode ?? 'completed';
  const connectionId = randomUUID();
  const [catalog] = await db<{ id: string; provider_id: string }[]>`
    select m.id,m.provider_id from allrice_model_catalog_entries m join allrice_model_providers p on p.id=m.provider_id
    where p.provider_key='codex' and p.auth_mode='chatgpt_subscription' and m.model='gpt-5.6-luna'`;
  if (!catalog) throw Error('lifecycle_subscription_catalog_missing');
  await db`insert into allrice_model_connections(id,provider_id,scope,name,credential_reference,base_url)
    values(${connectionId},${catalog.provider_id},'platform',${`synthetic-lifecycle-${connectionId}`},'deployment:synthetic-never-resolved',null)`;
  let modelSnapshot!: SessionModelSnapshot;
  const f = await createAssistantAuthorityFixture(db, {
    configure: false,
    allowedTools: ['assistant.delegate', 'assistant.report'],
    runtimePolicy: {
      harness: 'dsh',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      timeoutMs: 300000,
      fallbackModels: [],
      credentialReference: 'deployment:synthetic-never-resolved',
      baseUrl: null,
    },
    snapshot: (value, { sessionId }) => {
      modelSnapshot = SessionModelSnapshotSchema.parse({
        schemaVersion: 1,
        sessionId,
        employeeId: value.employee.id,
        policyRevision: 1,
        connectionId,
        modelCatalogEntryId: catalog.id,
        harness: 'dsh',
        provider: 'openai-codex',
        authMode: 'chatgpt_subscription',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'low',
        credentialReference: 'deployment:synthetic-never-resolved',
        baseUrl: null,
        fallbackPolicy: 'disabled',
        fallbackTargets: [],
        resolvedFallbacks: [],
        frozenAt: new Date().toISOString(),
      });
      return { ...value, modelSnapshot };
    },
  });
  f.config.maxConcurrent = 2;
  f.config.maxDepth = 1;
  f.config.maxChildren = 2;
  await db`update allrice_runs set input=jsonb_set(input,'{assistantConfiguration}',${db.json(f.config)}) where id=${f.rootRunId}`;
  // The shared authority fixture has no admitted child or usage yet. Let the
  // production controller freeze its own capacities; never rewrite live budgets.
  await db.begin(async (tx) => {
    await tx`delete from allrice_runtime_budgets where root_run_id=${f.rootRunId}`;
    await tx`delete from allrice_runtime_run_links where root_run_id=${f.rootRunId}`;
    await tx`delete from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
  });
  const decision = RouteDecisionSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    runId: f.rootRunId,
    organizationId: f.org,
    workspaceId: f.workspace,
    actorId: f.user,
    employeeId: f.employee,
    inputChecksum: `sha256:${'a'.repeat(64)}`,
    candidates: [
      {
        id: 'direct:synthetic',
        kind: 'direct',
        name: 'Synthetic lifecycle',
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
    model: modelSnapshot.model,
    modelConnectionId: connectionId,
    modelCatalogEntryId: catalog.id,
    modelPolicyRevision: 1,
    generation: f.worker.generation,
    attempt: 1,
    reasonCodes: ['direct_no_capability_match'],
    createdAt: new Date().toISOString(),
  });
  await recordRouteDecision(decision, db);
  const subscriptionSnapshot = resolveAssistantSubscriptionSnapshot({
    sessionId: f.session,
    modelSnapshot,
    decision,
    providerSnapshot: DshExecutionSnapshotSchema.parse(f.manifest.provider),
  })!;
  const proof = await freezeRouteSubscriptionSnapshot(
    {
      organizationId: f.org,
      workspaceId: f.workspace,
      decisionId: decision.id,
      snapshot: subscriptionSnapshot,
    },
    db,
  );
  const holds = { A: gate(), B: gate() };
  let bound!: Awaited<
    ReturnType<
      NonNullable<ReturnType<typeof productionAssistantController>>['bind']
    >
  > & { tree: () => ReturnType<typeof f.runtime.getTree> };
  const native = await p24Fixture(
    async (request) => {
      const text = JSON.stringify(request.messages);
      if (text.includes('ROOT_PRIVATE'))
        return { text: 'Synthetic parent remains isolated and responsive.' };
      const label = text.includes('LIFECYCLE_A') ? 'A' : 'B';
      await holds[label].promise;
      const status =
        mode === 'partial_failure'
          ? label === 'A'
            ? 'partial'
            : 'failed'
          : 'completed';
      return {
        ...(mode === 'unknown_usage' && label === 'B' ? { usage: null } : {}),
        ...(mode === 'over_budget' && label === 'A'
          ? {
              usage: {
                prompt_tokens: 20,
                completion_tokens: 6001,
                total_tokens: 6021,
              },
            }
          : {}),
        nativeTool: {
          name: 'assistant_report',
          arguments: {
            status,
            summary: `Synthetic ${label} ${status}`,
            evidence: [],
            incomplete:
              status === 'completed'
                ? []
                : ['Synthetic incomplete work; not a product/model result'],
            output: {
              name: 'report',
              content: JSON.stringify({
                label,
                status,
                source: 'loopback synthetic only',
              }),
            },
          },
        },
      };
    },
    undefined,
    {
      p25: true,
      callback: async (method, params) => {
        if (options.loseCheckpointAck && method === 'checkpoint')
          return bound.handle(method, {
            nativeSessionId: params.nativeSessionId,
            inputId: params.inputId,
            nativeMessageId: params.nativeMessageId,
          });
        return bound.handle(method, params);
      },
    },
  );
  const storage = new LocalStorageAdapter(join(native.root, 'artifacts'));
  const context: ExecutionContext = {
    executionId: randomUUID(),
    runId: f.rootRunId,
    jobId: f.worker.jobId,
    worker: { type: 'worker' as const, id: f.worker.workerId },
    delegatedBy: { type: 'user' as const, id: f.user },
    organizationId: f.org,
    workspaceId: f.workspace,
    startedAt: new Date().toISOString(),
    policySnapshot: {
      id: f.policy,
      organizationId: f.org,
      subjectId: f.user,
      version: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      memberships: f.context.memberships,
      grants: [
        {
          resourceType: 'job',
          action: 'job:execute',
          workspaceId: f.workspace,
        },
      ],
    },
  };
  const controllerInput = {
    configuration: f.config,
    context,
    worker: f.worker,
    tools: [{ name: 'assistant.delegate' }, { name: 'assistant.report' }],
    runLimits: {
      maxInputTokens: 20000,
      maxOutputTokens: 6000,
      maxTotalTokens: 26000,
      maxCostCents: 0,
    },
    authorize: assertAssistantAuthority,
    database: db,
    storage,
    subscriptionSnapshot,
  };
  let client: ReturnType<typeof native.launch>;
  let closed = false;
  try {
    const controller = productionAssistantController(controllerInput)!;
    bound = {
      ...(await controller.bind(f.nativeSessionId, f.worker.generation)),
      tree: () => f.runtime.getTree(f.context, { runId: f.rootRunId }),
    };
    client = native.launch();
    await client.call('ready');
    await client.call('create', { id: f.nativeSessionId });
    await client.call('p25/bind', { nativeSessionId: f.nativeSessionId });
    const children: {
      runId: string;
      nativeSessionId: string;
      label: string;
    }[] = [];
    return {
      f,
      db,
      native,
      client,
      bound,
      controllerInput,
      controller,
      nextAdmission: {
        organizationId: f.org,
        workspaceId: f.workspace,
        userId: f.user,
        employeeId: f.employee,
        connectionId,
        requestedTokens: 1,
        requestedRuntimeMs: 1000,
      },
      children,
      storage,
      proof,
      decision,
      async start() {
        if (children.length) throw Error('lifecycle_start_once');
        await client.call('prompt', {
          id: f.nativeSessionId,
          text: 'ROOT_PRIVATE controlled synthetic lifecycle',
        });
        await client.call('idle', { id: f.nativeSessionId });
        for (const label of ['A', 'B'] as const) {
          const dispatch = await bound.handle('delegate', {
            nativeSessionId: f.nativeSessionId,
            callId: randomUUID(),
            arguments: {
              label,
              text: `LIFECYCLE_${label}`,
              tools: ['assistant.report'],
            },
          });
          children.push(dispatch.instance as (typeof children)[number]);
          await client.call('p25/start', dispatch);
        }
      },
      releaseChild(label: 'A' | 'B') {
        holds[label].release();
      },
      /** UI may inspect/refresh cancel_requested before calling this. No invented ACK. */
      async drain() {
        return client.call('p25/drain', await bound.cancellation!());
      },
      async finish() {
        await client.call('p25/join', { nativeSessionId: f.nativeSessionId });
        await client.call('p25/flush');
        await client.call('p25/finish', { nativeSessionId: f.nativeSessionId });
        return bound.finish!();
      },
      async project(
        outcome: Awaited<ReturnType<NonNullable<typeof bound.finish>>>,
      ) {
        return completeRouteDecision(
          {
            organizationId: f.org,
            workspaceId: f.workspace,
            outcome: {
              decisionId: decision.id,
              status: outcome.status === 'completed' ? 'succeeded' : 'failed',
              inputTokens: outcome.usage.inputTokens,
              cachedInputTokens: 0,
              outputTokens: outcome.usage.outputTokens,
              costCents: null,
              usageComplete: outcome.usageComplete,
              cacheUsageKnown: false,
              errorCode:
                outcome.status === 'completed'
                  ? null
                  : 'SYNTHETIC_LIFECYCLE_OUTCOME',
              completedAt: new Date().toISOString(),
            },
          },
          db,
        );
      },
      async close() {
        if (!closed) {
          await native.close();
          holds.A.release();
          holds.B.release();
          closed = true;
        }
        const removed = await lstat(native.root).then(
          () => false,
          (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
        );
        if (!removed) throw Error('lifecycle_owned_native_cleanup_unconfirmed');
        return {
          nativeClosed: true,
          storageRemoved: true,
          loopbackClosed: true,
        };
      },
    };
  } catch (error) {
    await native.close();
    holds.A.release();
    holds.B.release();
    throw error;
  }
}
