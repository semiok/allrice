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
  HarnessExecutionSnapshot,
  RouteDecision,
} from '@allrice/contracts';
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

const state = vi.hoisted(() => ({
  database: undefined as
    Awaited<ReturnType<typeof createAssistantFixtureDatabase>> | undefined,
  adapter: undefined as DshHarnessAdapter | undefined,
  provider: undefined as HarnessExecutionSnapshot | undefined,
  resolved: vi.fn(),
  runtime: vi.fn(),
  record: vi.fn(),
  complete: vi.fn(),
  controller: vi.fn(),
  bind: vi.fn(),
  spawn: vi.fn(),
  credentials: vi.fn(),
}));
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
  appendJobEvent: vi.fn(async () => {}),
  releaseConversationRuntime: vi.fn(async () => {}),
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
vi.mock('../../src/routing/capability-router.js', () => ({
  decideCapabilityRoute: () => ({
    selectedKind: 'direct',
    selectedCandidateId: 'direct:synthetic',
    selectedKnowledgeRevisionIds: [],
    reasonCodes: ['direct_no_capability_match'],
    candidates: [
      {
        id: 'direct:synthetic',
        kind: 'direct',
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
      } = {},
    ) {
      const f = await createAssistantAuthorityFixture(database.db, {
        configure: false,
        allowedTools: ['assistant.delegate', 'assistant.report'],
      });
      const provider: HarnessExecutionSnapshot = options.legacy
        ? {
            provider: 'codex',
            authMode: 'chatgpt_subscription',
            model: 'synthetic-never-called',
            reasoningEffort: 'low',
            sandbox: 'workspace-write',
          }
        : {
            provider: 'dsh',
            authMode: options.compatible
              ? 'allrice_credential'
              : 'platform_subscription',
            route: options.compatible ? 'openai-compatible' : 'openai-codex',
            model: 'synthetic-never-called',
            reasoningEffort: 'low',
            credentialReference: 'deployment:synthetic-never-resolved',
            baseUrl: options.compatible ? 'http://127.0.0.1:1/v1' : null,
          };
      state.provider = provider;
      state.resolved.mockResolvedValue({
        providerSnapshot: provider,
        executionSnapshot: f.snapshot,
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
          job: { ownerId: f.user, attempt: 1 },
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
        const { f, job } = await fixture({ compatible: true });
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
  },
);
