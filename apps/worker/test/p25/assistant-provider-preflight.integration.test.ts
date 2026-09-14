/** Actual Worker/adapter/control flow + real isolated PG accounting. All native
 * acquisition is intercepted before credentials/process/network access. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Database from '@allrice/database';
import type * as Router from '../../src/harness/router.js';
import type * as Controller from '../../src/harness/dsh/assistant-controller.js';
import type {
  EmployeeExecutionSnapshot,
  HarnessExecutionSnapshot,
  RouteDecision,
} from '@allrice/contracts';
import {
  SessionModelSnapshotSchema,
  FrozenWorkflowBindingSchema,
} from '@allrice/contracts';
import type * as Workflow from '../../src/workflow-engine.js';
import type { ClaimedJobHandlerInput } from '../../src/job-runner.js';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
import {
  recordRouteDecision as recordActual,
  completeRouteDecision as completeActual,
} from '../../../../packages/database/src/execution/route-decision.ts';
import {
  getOrganizationModelQuota,
  assertQuotaAvailable,
} from '../../../../packages/database/src/providers/model-governance.ts';
import { executeEmployeeRun } from '../../src/jobs/employee-run.js';
import { HandlerError } from '../../src/errors.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.js';
import { assistantPriceSnapshotDigest } from '../../src/assistant-pricing-preflight.js';
import { AssistantExecutionUnresolvedError } from '../../src/harness/dsh/assistant-outcome.js';

const state = vi.hoisted(() => ({
  database: undefined as
    Awaited<ReturnType<typeof createAssistantFixtureDatabase>> | undefined,
  adapter: undefined as DshHarnessAdapter | undefined,
  provider: undefined as HarnessExecutionSnapshot | undefined,
  resolved: vi.fn(),
  runtime: vi.fn(),
  record: vi.fn(),
  complete: vi.fn(),
  append: vi.fn(),
  controller: vi.fn(),
  bind: vi.fn(),
  spawn: vi.fn(),
  credentials: vi.fn(),
  workflowId: null as string | null,
  workflow: vi.fn(),
}));
// Internal governance helpers import this module directly. Bind it too; never
// let a new frozen model snapshot fall through to a real application database.
vi.mock(
  '../../../../packages/database/src/core/client.ts',
  async (original) => ({
    ...(await original<Record<string, unknown>>()),
    getDatabase: () => {
      if (!state.database)
        throw Error('isolated_test_database_not_initialized');
      return state.database.db;
    },
  }),
);
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getDatabase: () => {
    if (!state.database) throw Error('isolated_test_database_not_initialized');
    return state.database.db;
  },
  resolveEmployeeExecution: state.resolved,
  acquireConversationRuntime: state.runtime,
  recordRouteDecision: state.record,
  completeRouteDecision: state.complete,
  assertReviewRunCurrent: vi.fn(async () => {}),
  getLatestContextCheckpoint: vi.fn(async () => null),
  getChangesetRun: vi.fn(async () => null),
  getCodexProviderStatus: vi.fn(async () => ({ status: 'connected' })),
  listFailedRouteDecisions: vi.fn(async () => []),
  appendJobEvent: state.append,
  claimConversationSteer: vi.fn(async () => null),
  releaseConversationRuntime: vi.fn(async () => {}),
  ensureWorkflowRunForExecution: vi.fn(async () => {}),
}));
vi.mock('../../src/harness/router.js', async (original) => ({
  ...(await original<typeof Router>()),
  getHarnessRouter: () => ({
    select: () => ({
      adapter: state.adapter,
      providerSnapshot: state.provider,
      reasonCode: 'primary_provider_selected',
    }),
    resolve: () => state.adapter,
  }),
}));
vi.mock('../../src/knowledge.js', () => ({
  buildAuthorizedKnowledgeContext: vi.fn(async () => ({
    context: '',
    citations: [],
  })),
}));
vi.mock('../../src/conversation/checkpoint-maintenance.js', () => ({
  finalizeEmployeeConversationContext: async () => state.runtime(),
}));
vi.mock('../../src/workflow-engine.js', async (original) => ({
  ...(await original<typeof Workflow>()),
  executeDurableWorkflow: state.workflow,
}));
vi.mock('../../src/routing/capability-router.js', () => ({
  decideCapabilityRoute: () => ({
    selectedKind: state.workflowId ? 'workflow' : 'direct',
    selectedCandidateId: state.workflowId
      ? `workflow:${state.workflowId}`
      : 'direct:synthetic',
    selectedKnowledgeRevisionIds: [],
    reasonCodes: ['direct_no_capability_match'],
    candidates: [
      {
        id: state.workflowId
          ? `workflow:${state.workflowId}`
          : 'direct:synthetic',
        kind: state.workflowId ? 'workflow' : 'direct',
        name: 'Synthetic no-provider task',
        bindingId: null,
        requiredCapabilities: ['model:invoke'],
        risk: 'low',
        requiresApproval: false,
        authorized: true,
        exclusionReason: null,
        score: 1,
      },
    ],
  }),
}));
vi.mock('../../src/harness/dsh/assistant-controller.js', async (original) => {
  const actual = await original<typeof Controller>();
  return {
    ...actual,
    productionAssistantController: (
      ...args: Parameters<typeof actual.productionAssistantController>
    ) => {
      state.controller(...args);
      const result = actual.productionAssistantController(...args);
      if (result) {
        const bind = result.bind;
        result.bind = (...input) => {
          state.bind();
          return bind(...input);
        };
      }
      return result;
    },
  };
});
vi.mock('node:child_process', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  spawn: (...args: unknown[]) => {
    state.spawn(...args);
    throw Error('test_forbids_native_process_spawn');
  },
}));

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'P25 Worker provider preflight accounting (actual isolated PG; zero provider requests)',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let temporary: string;
    let adapter: DshHarnessAdapter;
    let acquire: MockInstance<DshRuntimePool['acquire']>;
    let execute: MockInstance<DshHarnessAdapter['execute']>;
    const rejectionCode = 'ASSISTANT_PROVIDER_OUTPUT_BOUND_UNSUPPORTED';
    const lateError = Error('synthetic_uncertain_adapter_failure');
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
      state.database = database;
      temporary = await mkdtemp(join(tmpdir(), 'allrice-p25-preflight-'));
      vi.stubEnv('ALLRICE_STORAGE_ROOT', join(temporary, 'storage'));
      adapter = new DshHarnessAdapter({
        runtimeRoot: join(temporary, 'runtime'),
        runtimeCommand: process.execPath,
        runtimeArgs: [],
        credentialResolver: { resolve: state.credentials },
      });
      state.adapter = adapter;
      // Exercise real execute() and its gate; stop acquisition at the first port.
      // A generic failure after this boundary is deliberately uncertain, not free.
      acquire = vi.spyOn(DshRuntimePool.prototype, 'acquire');
      execute = vi.spyOn(adapter, 'execute');
    }, 120000);
    beforeEach(() => {
      vi.clearAllMocks();
      vi.stubEnv('ALLRICE_ASSISTANT_PRICING_JSON', undefined);
      vi.stubEnv('ALLRICE_ASSISTANT_PRICING_CURRENCY', undefined);
      state.workflowId = null;
      state.append.mockResolvedValue(undefined);
      acquire.mockRejectedValue(lateError);
      state.credentials.mockRejectedValue(Error('test_forbids_credentials'));
      state.record.mockImplementation((decision: RouteDecision) =>
        recordActual(decision, database.db),
      );
      state.complete.mockImplementation(
        (input: Parameters<typeof completeActual>[0]) =>
          completeActual(input, database.db),
      );
    });
    afterAll(async () => {
      try {
        await adapter?.close();
        await database?.close();
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    });
    async function fixture(
      options: {
        enabled?: boolean;
        omitted?: boolean;
        compatible?: boolean;
        legacy?: boolean;
        price?: boolean;
        workflow?: boolean;
      } = {},
    ) {
      const connectionId = randomUUID(),
        catalogId = randomUUID();
      const model = options.compatible
        ? `synthetic-${catalogId}`
        : 'synthetic-never-called';
      const endpoint = 'https://synthetic-never-contacted.example.test/v1';
      let capturedSnapshot: EmployeeExecutionSnapshot | undefined;
      const workflow = options.workflow
        ? FrozenWorkflowBindingSchema.parse({
            bindingId: randomUUID(),
            boundBy: randomUUID(),
            boundAt: new Date().toISOString(),
            effective: true,
            revision: {
              kind: 'workflow',
              id: randomUUID(),
              workflowId: randomUUID(),
              slug: 'synthetic-workflow',
              name: 'Synthetic workflow',
              description: 'Synthetic workflow boundary only',
              revision: 1,
              status: 'published',
              checksum: `sha256:${'d'.repeat(64)}`,
              publishedAt: new Date().toISOString(),
              definition: {
                schemaVersion: 1,
                steps: [
                  { key: 'model_step', name: 'Synthetic model', kind: 'model' },
                ],
              },
            },
          })
        : undefined;
      if (workflow) {
        state.workflowId = workflow.revision.id;
        state.workflow.mockImplementation(
          async (
            input: Parameters<typeof Workflow.executeDurableWorkflow>[0],
          ) => {
            const result = await input.executeStep({
              step: workflow.revision.definition.steps[0]!,
              value: { workflowInput: {}, configured: {}, dependencies: {} },
              idempotencyKey: 'synthetic-workflow-step',
            });
            return { output: { model_step: result.output } };
          },
        );
      }
      if (options.compatible) {
        await database.db`insert into allrice_model_providers(id,provider_key,name,harness,auth_mode) values(${randomUUID()},'openai-compatible','Synthetic','dsh','api_key') on conflict(provider_key) do nothing`;
        const [provider] =
          await database.db`select id from allrice_model_providers where provider_key='openai-compatible'`;
        await database.db`insert into allrice_model_connections(id,provider_id,scope,name,credential_reference,base_url) values(${connectionId},${provider!.id},'platform',${`synthetic-${connectionId}`},'deployment:synthetic-never-resolved',${endpoint})`;
        await database.db`insert into allrice_model_catalog_entries(id,provider_id,model,display_name,reasoning_efforts,default_reasoning_effort,input_modalities,output_modalities)
          values(${catalogId},${provider!.id},${model},'Synthetic','["low"]','low','["text"]','["text"]')`;
      }
      const f = await createAssistantAuthorityFixture(database.db, {
        configure: false,
        allowedTools: ['assistant.delegate', 'assistant.report'],
        ...(options.compatible
          ? {
              runtimePolicy: {
                harness: 'dsh' as const,
                provider: 'openai-compatible',
                model,
                reasoningEffort: 'low' as const,
                timeoutMs: 300000,
                fallbackModels: [],
                credentialReference: 'deployment:synthetic-never-resolved',
                baseUrl: endpoint,
              },
              snapshot: (
                value: EmployeeExecutionSnapshot,
                { sessionId }: { sessionId: string },
              ) => {
                capturedSnapshot = {
                  ...value,
                  ...(workflow && value.schemaVersion === 2
                    ? {
                        capabilitySnapshot: {
                          ...value.capabilitySnapshot,
                          workflows: [workflow],
                        },
                      }
                    : {}),
                  modelSnapshot: SessionModelSnapshotSchema.parse({
                    schemaVersion: 1,
                    sessionId,
                    employeeId: value.employee.id,
                    policyRevision: 1,
                    connectionId,
                    modelCatalogEntryId: catalogId,
                    harness: 'dsh',
                    provider: 'openai-compatible',
                    authMode: 'api_key',
                    model,
                    reasoningEffort: 'low',
                    credentialReference: 'deployment:synthetic-never-resolved',
                    baseUrl: endpoint,
                    fallbackPolicy: 'disabled',
                    fallbackTargets: [],
                    resolvedFallbacks: [],
                    frozenAt: new Date().toISOString(),
                  }),
                } as EmployeeExecutionSnapshot;
                return capturedSnapshot;
              },
            }
          : {}),
      });
      const provider: HarnessExecutionSnapshot = options.legacy
        ? {
            provider: 'codex',
            authMode: 'chatgpt_subscription',
            model,
            reasoningEffort: 'low',
            sandbox: 'workspace-write',
          }
        : {
            provider: 'dsh',
            authMode: options.compatible
              ? 'allrice_credential'
              : 'platform_subscription',
            route: options.compatible ? 'openai-compatible' : 'openai-codex',
            model,
            reasoningEffort: 'low',
            credentialReference: 'deployment:synthetic-never-resolved',
            baseUrl: options.compatible ? endpoint : null,
          };
      state.provider = provider;
      state.resolved.mockResolvedValue({
        providerSnapshot: provider,
        executionSnapshot: capturedSnapshot ?? f.snapshot,
        promptSnapshot: {
          systemPrompt: 'Synthetic system',
          userRequest: 'Read synthetic input',
          conversation: [],
          memories: [],
          imageAttachments: [],
        },
        nativeSkills: [],
        skillArtifacts: [],
        grantedCapabilities: ['model:invoke'],
      });
      if (options.price) {
        vi.stubEnv('ALLRICE_ASSISTANT_PRICING_CURRENCY', 'USD');
        vi.stubEnv(
          'ALLRICE_ASSISTANT_PRICING_JSON',
          JSON.stringify({
            version: 1,
            catalogVersion: 'synthetic-only',
            entries: [
              {
                id: 'synthetic',
                target: {
                  connectionId,
                  catalogId,
                  harness: 'dsh',
                  provider: 'openai-compatible',
                  authMode: 'api_key',
                  model,
                  baseUrl: endpoint,
                  serviceTier: 'default',
                  modality: 'text',
                },
                billingMode: 'token_metered',
                currency: 'USD',
                effectiveAt: '2020-01-01T00:00:00.000Z',
                expiresAt: '2099-01-01T00:00:00.000Z',
                maxInputTokens: 1000000,
                maxOutputTokens: 1000000,
                rates: {
                  uncachedInputMicrounitsPerMillion: '2000000',
                  cacheReadMicrounitsPerMillion: '500000',
                  cacheWriteMicrounitsPerMillion: '3000000',
                  outputMicrounitsPerMillion: '8000000',
                },
                source: {
                  reference: 'synthetic-only-no-real-provider',
                  digest: `sha256:${'a'.repeat(64)}`,
                },
              },
            ],
          }),
        );
      }
      state.runtime.mockResolvedValue({
        generation: 1,
        threadId: `dsh-${f.session}`,
        activeTurnId: null,
      });
      const job: ClaimedJobHandlerInput = {
        execution: {
          payload: {
            type: 'allrice.employee.run',
            input: {
              employeeAssignmentId: f.assignment,
              employeeVersionId: f.version,
              sessionId: f.session,
              userMessageId: randomUUID(),
              assistantMessageId: randomUUID(),
              ...(options.omitted
                ? {}
                : {
                    assistantConfiguration: {
                      ...f.config,
                      allowAssistants: options.enabled ?? true,
                    },
                  }),
            },
          },
          context: {
            ...f.context,
            runId: f.rootRunId,
            delegatedBy: f.context.actor,
            worker: { type: 'worker', id: f.worker.workerId },
            policySnapshot: { memberships: f.context.memberships },
          },
          job: {
            ownerId: f.user,
            attempt: 1,
            timeoutAt: new Date(Date.now() + 300000).toISOString(),
          },
        },
        isolation: { workDirectory: temporary, environment: {} },
        signal: new AbortController().signal,
        onHarnessEvent: async () => {},
        workflowLease: f.worker,
      } as unknown as ClaimedJobHandlerInput;
      return { f, job };
    }
    async function accounting(org: string) {
      const rows = await database.db<
        {
          decision_cost: string | null;
          ledger_cost: string | null;
          decision_complete: boolean;
          ledger_complete: boolean;
          decision_cache: boolean;
          ledger_cache: boolean;
          input_tokens: number;
          cached_input_tokens: number;
          output_tokens: number;
          error_code: string;
          provider: string;
        }[]
      >`select d.cost_cents as decision_cost,l.cost_cents as ledger_cost,
      d.usage_complete as decision_complete,l.usage_complete as ledger_complete,
      d.cache_usage_known as decision_cache,l.cache_usage_known as ledger_cache,
      l.input_tokens,l.cached_input_tokens,l.output_tokens,d.error_code,d.provider
      from allrice_route_decisions d join allrice_model_usage_ledger l on l.route_decision_id=d.id
      where d.organization_id=${org}`;
      expect(rows).toHaveLength(1);
      expect(state.complete).toHaveBeenCalledTimes(1);
      return {
        row: rows[0]!,
        quota: await getOrganizationModelQuota(org, database.db),
      };
    }
    async function knownZero(org: string) {
      const { row, quota } = await accounting(org);
      expect(row).toMatchObject({
        decision_complete: true,
        ledger_complete: true,
        decision_cache: true,
        ledger_cache: true,
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
      });
      expect(row.decision_cost).not.toBeNull();
      expect(row.ledger_cost).not.toBeNull();
      expect(Number(row.decision_cost)).toBe(0);
      expect(Number(row.ledger_cost)).toBe(0);
      expect(quota).toMatchObject({
        usedRuns: 1,
        usedTokens: 0,
        usedCostCents: 0,
        unknownCostRuns: 0,
        usageComplete: true,
        cacheUsageKnown: true,
      });
      expect(() => assertQuotaAvailable(quota)).not.toThrow();
      expect(state.complete.mock.calls[0]![0].outcome).toMatchObject({
        status: 'failed',
        failureCategory: null,
      });
      return row;
    }
    function noNativeAccess() {
      expect(state.credentials).not.toHaveBeenCalled();
      expect(state.spawn).not.toHaveBeenCalled();
      expect(state.bind).not.toHaveBeenCalled();
      expect(adapter.runtimeInventory()).toEqual([]);
    }
    it.each([false, true])(
      'refuses Codex assistants before execution (legacy snapshot %s), preserving real known-zero quota',
      async (legacy) => {
        const { f, job } = await fixture({ legacy });
        await expect(executeEmployeeRun(job)).rejects.toMatchObject({
          code: rejectionCode,
          retryable: false,
        });
        expect(execute).not.toHaveBeenCalled();
        expect(acquire).not.toHaveBeenCalled();
        expect(state.controller).not.toHaveBeenCalled();
        noNativeAccess();
        expect((await knownZero(f.org)).error_code).toBe(rejectionCode);
        const roots =
          await database.db`select root_run_id from allrice_assistant_roots where root_run_id=${f.rootRunId}`;
        expect(roots).toHaveLength(0);
      },
    );
    it('preflights the persisted replay route, not a newly selected compatible provider', async () => {
      const { f, job } = await fixture({ compatible: true });
      state.record.mockImplementation(async (proposed: RouteDecision) => {
        await recordActual(
          { ...proposed, provider: 'openai-codex' },
          database.db,
        );
        return recordActual(proposed, database.db); // Actual run+attempt conflict returns the existing route.
      });
      await expect(executeEmployeeRun(job)).rejects.toMatchObject({
        code: rejectionCode,
      });
      expect(execute).not.toHaveBeenCalled();
      noNativeAccess();
      expect((await knownZero(f.org)).provider).toBe('openai-codex');
    });
    it.each([false, true])(
      'ordinary Codex still enters the original adapter acquisition path (configuration omitted %s)',
      async (omitted) => {
        const { f, job } = await fixture({ enabled: false, omitted });
        await expect(executeEmployeeRun(job)).rejects.toBe(lateError);
        expect(adapter.isConfigured(state.provider!)).toBe(true);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0]![0].assistants).toBeUndefined();
        expect(acquire).toHaveBeenCalledTimes(1);
        noNativeAccess();
        await knownZero(f.org);
      },
    );
    it.each([false, true])(
      'after assistant execution is entered, uncertainty cannot be relabeled free (same preflight code %s)',
      async (sameCode) => {
        const { f, job } = await fixture({ compatible: true, price: true });
        const error = sameCode
          ? new HandlerError(
              rejectionCode,
              'Synthetic late failure, not proof of zero usage',
              false,
            )
          : lateError;
        acquire.mockRejectedValue(error);
        await expect(executeEmployeeRun(job)).rejects.toBe(error);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0]![0].assistants).toBeDefined();
        expect(acquire).toHaveBeenCalledTimes(1);
        noNativeAccess();
        const { row, quota } = await accounting(f.org);
        expect(row).toMatchObject({
          decision_cost: null,
          ledger_cost: null,
          decision_complete: false,
          ledger_complete: false,
          decision_cache: false,
          ledger_cache: false,
        });
        expect(quota).toMatchObject({
          usedRuns: 1,
          usedCostCents: null,
          unknownCostRuns: 1,
          usageComplete: false,
          cacheUsageKnown: false,
        });
        expect(() => assertQuotaAvailable(quota)).toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
        const captured = state.complete.mock.calls[0]![0] as Parameters<
          typeof completeActual
        >[0];
        await expect(
          completeActual(
            {
              ...captured,
              outcome: {
                ...captured.outcome,
                costCents: 0,
                usageComplete: true,
                cacheUsageKnown: true,
              },
            },
            database.db,
          ),
        ).rejects.toThrow('route decision outcome conflict');
        expect(
          await getOrganizationModelQuota(f.org, database.db),
        ).toMatchObject({
          usedCostCents: null,
          unknownCostRuns: 1,
          usageComplete: false,
        });
      },
    );
    it.each([
      { canceled: false, appendFailure: false },
      { canceled: true, appendFailure: false },
      { canceled: false, appendFailure: true },
      { canceled: true, appendFailure: true },
    ])(
      'retains safe assistant first cause and unknown accounting (canceled $canceled, event append fails $appendFailure)',
      async ({ canceled, appendFailure }) => {
        const { f, job } = await fixture({ compatible: true, price: true });
        const turnId = randomUUID();
        const threadId = `dsh-${f.session}`;
        state.runtime.mockResolvedValue({
          generation: 1,
          threadId,
          activeTurnId: turnId,
        });
        const assistantDiagnostics = {
          version: 1,
          failures: [
            {
              nativeSessionId: threadId,
              callId: randomUUID(),
              phase: 'stream',
              code: 'QUOTA_EXCEEDED',
              stopKind: 'error',
              inputUsageKnown: true,
              outputUsageKnown: false,
              settlementConfirmed: false,
              settlementFailureCode: 'SETTLEMENT_FAILED',
            },
          ],
          truncated: false,
        };
        const usage = {
          inputTokens: 137,
          cachedInputTokens: 11,
          outputTokens: 23,
        };
        const original = new AssistantExecutionUnresolvedError(
          usage,
          false,
          assistantDiagnostics,
        );
        const rawGetter = vi.fn(() => {
          throw Error('synthetic_provider_error_body_must_not_be_read');
        });
        Object.defineProperties(original, {
          cause: { get: rawGetter },
          providerResponse: { get: rawGetter },
          rawBody: { value: 'synthetic-private-provider-body' },
        });
        const controller = new AbortController();
        acquire.mockImplementationOnce(async () => {
          if (canceled) controller.abort();
          throw original;
        });
        const type = canceled ? 'turn.canceled' : 'turn.failed';
        if (appendFailure)
          state.append.mockImplementation(
            async (input: Parameters<typeof Database.appendJobEvent>[0]) => {
              if (input.type === type)
                throw Error('synthetic_terminal_event_persistence_failure');
            },
          );
        await expect(
          executeEmployeeRun({ ...job, signal: controller.signal }),
        ).rejects.toBe(original);
        const terminalEvents = state.append.mock.calls
          .map(
            ([input]) => input as Parameters<typeof Database.appendJobEvent>[0],
          )
          .filter((input) => input.type === type);
        expect(terminalEvents).toEqual([
          {
            ...job.workflowLease,
            type,
            payload: {
              source: 'dsh',
              threadId,
              turnId,
              generation: 1,
              assistantDiagnostics,
            },
          },
        ]);
        expect(rawGetter).not.toHaveBeenCalled();
        expect(JSON.stringify(terminalEvents)).not.toContain(
          'synthetic-private-provider-body',
        );
        expect(execute).toHaveBeenCalledTimes(1);
        expect(acquire).toHaveBeenCalledTimes(1);
        noNativeAccess();
        const { row, quota } = await accounting(f.org);
        expect(row).toMatchObject({
          decision_cost: null,
          ledger_cost: null,
          decision_complete: false,
          ledger_complete: false,
          decision_cache: false,
          ledger_cache: false,
          input_tokens: usage.inputTokens,
          cached_input_tokens: usage.cachedInputTokens,
          output_tokens: usage.outputTokens,
          error_code: 'ASSISTANT_EXECUTION_UNRESOLVED',
        });
        expect(quota).toMatchObject({
          usedRuns: 1,
          usedCostCents: null,
          unknownCostRuns: 1,
          usageComplete: false,
          cacheUsageKnown: false,
        });
        expect(() => assertQuotaAvailable(quota)).toThrow(
          'MODEL_TOKEN_USAGE_UNKNOWN',
        );
        expect(state.complete.mock.calls[0]![0].outcome).toMatchObject({
          status: canceled ? 'canceled' : 'failed',
          failureCategory: null,
        });
      },
    );
    it.each([
      { name: 'absent', diagnostics: undefined },
      {
        name: 'empty',
        diagnostics: { version: 1, failures: [], truncated: false },
      },
      {
        name: 'invalid with raw body',
        diagnostics: {
          version: 1,
          failures: [],
          truncated: false,
          rawBody: 'synthetic-private-provider-body',
        },
      },
    ])(
      'omits $name assistant diagnostics from the failure event',
      async ({ diagnostics }) => {
        const { f, job } = await fixture({ compatible: true, price: true });
        const turnId = randomUUID();
        const threadId = `dsh-${f.session}`;
        state.runtime.mockResolvedValue({
          generation: 1,
          threadId,
          activeTurnId: turnId,
        });
        const original = new AssistantExecutionUnresolvedError(
          { inputTokens: 3, cachedInputTokens: 0, outputTokens: 1 },
          false,
          diagnostics,
        );
        acquire.mockRejectedValueOnce(original);
        await expect(executeEmployeeRun(job)).rejects.toBe(original);
        const terminalEvents = state.append.mock.calls
          .map(
            ([input]) => input as Parameters<typeof Database.appendJobEvent>[0],
          )
          .filter((input) => input.type === 'turn.failed');
        expect(terminalEvents).toEqual([
          {
            ...job.workflowLease,
            type: 'turn.failed',
            payload: { source: 'dsh', threadId, turnId, generation: 1 },
          },
        ]);
        noNativeAccess();
      },
    );
    it.each([undefined, '{invalid-secret-payload'])(
      'missing or invalid configured price fails before adapter with known-zero real accounting (%s)',
      async (encoded) => {
        const { f, job } = await fixture({ compatible: true });
        vi.stubEnv('ALLRICE_ASSISTANT_PRICING_JSON', encoded);
        vi.stubEnv('ALLRICE_ASSISTANT_PRICING_CURRENCY', 'USD');
        await expect(executeEmployeeRun(job)).rejects.toMatchObject({
          code: 'ASSISTANT_PRICE_UNAVAILABLE',
          retryable: false,
        });
        expect(execute).not.toHaveBeenCalled();
        expect(acquire).not.toHaveBeenCalled();
        expect(state.controller).not.toHaveBeenCalled();
        noNativeAccess();
        expect((await knownZero(f.org)).error_code).toBe(
          'ASSISTANT_PRICE_UNAVAILABLE',
        );
      },
    );
    it('a synthetic complete whole-tree priced result persists its upper bound and leaves the next ordinary Run quota available', async () => {
      const { f, job } = await fixture({ compatible: true, price: true });
      // Only this success case supplies a synthetic adapter result. Native
      // receipt production is tested separately by the real HTTP/PG suite.
      // This case exercises actual Worker validation and both real route tables.
      execute.mockImplementationOnce(async () => {
        const configuration = state.controller.mock.calls.at(
          -1,
        )![0] as Parameters<typeof Controller.productionAssistantController>[0];
        return {
          answer: 'Synthetic completed tree',
          assistantStatus: 'completed',
          provider: 'openai-compatible',
          model: state.provider!.model,
          usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 30 },
          usageComplete: true,
          cacheUsageKnown: false,
          costEstimateAvailable: true,
          estimatedCostCents: 0.054,
          costBasis: 'conservative_upper_bound',
          actualCostKnown: false,
          costCurrency: 'USD',
          priceSnapshotDigest: assistantPriceSnapshotDigest(
            configuration.priceSnapshot!,
          ),
        };
      });
      await expect(executeEmployeeRun(job)).resolves.toMatchObject({
        estimatedCostCents: 0.054,
        actualCostKnown: false,
      });
      const { row, quota } = await accounting(f.org);
      expect(Number(row.decision_cost)).toBe(0.054);
      expect(Number(row.ledger_cost)).toBe(0.054);
      expect(row).toMatchObject({
        decision_complete: true,
        ledger_complete: true,
        decision_cache: false,
        ledger_cache: false,
      });
      expect(quota).toMatchObject({
        usedCostCents: 0.054,
        unknownCostRuns: 0,
        usageComplete: true,
        cacheUsageKnown: false,
      });
      expect(() => assertQuotaAvailable(quota)).not.toThrow();
      const nextRunId = randomUUID();
      await database.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
        values(${nextRunId},${f.org},${f.workspace},${f.user},'running','{}','{}')`;
      const next = {
        ...job,
        execution: {
          ...job.execution,
          context: { ...job.execution.context, runId: nextRunId },
          payload: {
            ...job.execution.payload,
            input: {
              ...(job.execution.payload.input as Record<string, unknown>),
              assistantConfiguration: { ...f.config, allowAssistants: false },
            },
          },
        },
      } as ClaimedJobHandlerInput;
      await expect(executeEmployeeRun(next)).rejects.toBe(lateError);
      expect(acquire).toHaveBeenCalledTimes(1); // Not rejected by unknown-cost quota.
      noNativeAccess();
      expect(await getOrganizationModelQuota(f.org, database.db)).toMatchObject(
        {
          usedRuns: 2,
          usedCostCents: 0.054,
          unknownCostRuns: 0,
          usageComplete: true,
          cacheUsageKnown: false,
        },
      );
    });
    it('rejects matching CNY config before execution instead of mixing it into the currency-less organization ledger', async () => {
      const { f, job } = await fixture({ compatible: true, price: true });
      const synthetic = JSON.parse(process.env.ALLRICE_ASSISTANT_PRICING_JSON!);
      synthetic.entries[0].currency = 'CNY';
      vi.stubEnv('ALLRICE_ASSISTANT_PRICING_JSON', JSON.stringify(synthetic));
      vi.stubEnv('ALLRICE_ASSISTANT_PRICING_CURRENCY', 'CNY');
      await expect(executeEmployeeRun(job)).rejects.toMatchObject({
        code: 'ASSISTANT_PRICE_CURRENCY_UNSUPPORTED',
        retryable: false,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(state.controller).not.toHaveBeenCalled();
      noNativeAccess();
      expect((await knownZero(f.org)).error_code).toBe(
        'ASSISTANT_PRICE_CURRENCY_UNSUPPORTED',
      );
    });
    it('a mismatched priced result cannot silently fall back to the ordinary missing-price zero', async () => {
      const { f, job } = await fixture({ compatible: true, price: true });
      execute.mockResolvedValueOnce({
        answer: 'Synthetic unverified result',
        assistantStatus: 'completed',
        provider: 'openai-compatible',
        model: state.provider!.model,
        usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 30 },
        usageComplete: true,
        cacheUsageKnown: false,
        costEstimateAvailable: true,
        estimatedCostCents: 0,
        costBasis: 'conservative_upper_bound',
        actualCostKnown: false,
        costCurrency: 'USD',
        priceSnapshotDigest: `sha256:${'c'.repeat(64)}`,
      });
      await expect(executeEmployeeRun(job)).rejects.toMatchObject({
        code: 'ASSISTANT_PRICE_RESULT_UNVERIFIED',
      });
      const { row, quota } = await accounting(f.org);
      expect(row).toMatchObject({
        decision_cost: null,
        ledger_cost: null,
        decision_complete: true,
        ledger_complete: true,
        decision_cache: false,
        ledger_cache: false,
      });
      expect(quota).toMatchObject({ usedCostCents: null, unknownCostRuns: 1 });
      expect(() => assertQuotaAvailable(quota)).toThrow(
        'MODEL_COST_USAGE_UNKNOWN',
      );
      noNativeAccess();
    });
    it('retains the existing assistant+workflow denial before dispatch and records known zero', async () => {
      const { f, job } = await fixture({
        compatible: true,
        price: true,
        workflow: true,
      });
      await expect(executeEmployeeRun(job)).rejects.toMatchObject({
        code: 'ASSISTANT_ROUTE_UNAVAILABLE',
      });
      expect(execute).not.toHaveBeenCalled();
      expect(state.workflow).not.toHaveBeenCalled();
      noNativeAccess();
      expect((await knownZero(f.org)).error_code).toBe(
        'ASSISTANT_ROUTE_UNAVAILABLE',
      );
    });
    it('ordinary workflow model steps keep the original estimator, even without assistant pricing configured', async () => {
      const { f, job } = await fixture({
        compatible: true,
        enabled: false,
        workflow: true,
      });
      vi.stubEnv(
        'ALLRICE_MODEL_PRICING_JSON',
        JSON.stringify({
          [`openai-compatible:${state.provider!.model}`]: {
            inputCentsPerMillion: 100000,
            outputCentsPerMillion: 100000,
          },
        }),
      );
      execute.mockResolvedValueOnce({
        answer: 'Synthetic workflow model result',
        provider: 'openai-compatible',
        model: state.provider!.model,
        usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
      });
      try {
        await expect(executeEmployeeRun(job)).resolves.toMatchObject({
          answer: 'Synthetic workflow model result',
        });
        expect(state.workflow).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0]![0].assistants).toBeUndefined();
        const { row, quota } = await accounting(f.org);
        expect(Number(row.decision_cost)).toBe(1.5);
        expect(Number(row.ledger_cost)).toBe(1.5);
        expect(quota).toMatchObject({
          unknownCostRuns: 0,
          usageComplete: true,
          usedCostCents: 1.5,
        });
        noNativeAccess();
      } finally {
        vi.stubEnv('ALLRICE_MODEL_PRICING_JSON', undefined);
      }
    });
  },
);
