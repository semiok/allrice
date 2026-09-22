/** Cross-Run admission regression: real isolated PG/authority/budget methods.
 * Only the database locator is redirected; no quota/admission method is mocked,
 * no native host starts, and no provider or application tenant is contacted. */
import { randomUUID } from 'node:crypto';
import { RouteDecisionSchema } from '@allrice/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import {
  admitModelExecution,
  assertQuotaAvailable,
  getOrganizationModelQuota,
} from './providers/model-governance.ts';
import {
  completeRouteDecision,
  recordRouteDecision,
} from './execution/route-decision.ts';

const state = vi.hoisted(() => ({
  database: undefined as
    Awaited<ReturnType<typeof createAssistantFixtureDatabase>> | undefined,
}));
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDatabase: () => {
    if (!state.database) throw Error('isolated_test_database_not_initialized');
    return state.database.db;
  },
}));

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration(
  'assistant cross-Run quota admission (isolated PG; no model requests)',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
      state.database = database;
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
        state.database = undefined;
        vi.unstubAllEnvs();
      }
    });

    async function fixture() {
      const a = await createAssistantAuthorityFixture(database.db, {
        allowedTools: ['assistant.delegate', 'assistant.report'],
      });
      const connectionId = randomUUID();
      await database.db`insert into allrice_model_providers(id,provider_key,name,harness,auth_mode)
      values(${randomUUID()},'openai-compatible','Synthetic','dsh','api_key')
      on conflict(provider_key) do nothing`;
      const [provider] =
        await database.db`select id from allrice_model_providers where provider_key='openai-compatible'`;
      await database.db`insert into allrice_model_connections(id,provider_id,scope,name,credential_reference,base_url)
      values(${connectionId},${provider!.id},'platform',${`synthetic-quota-${connectionId}`},
      'deployment:synthetic-never-resolved','https://synthetic-never-contacted.example.test/v1')`;
      // A separate queued Run B in the same organization. Admission itself has no
      // runId parameter; these real rows demonstrate B is not A's retry/old lease.
      const nextRunId = randomUUID();
      await database.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      values(${nextRunId},${a.org},${a.workspace},${a.user},'queued','{}','{}')`;
      await database.db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload)
      values(${randomUUID()},${a.org},${a.workspace},${a.user},${nextRunId},'queued',${randomUUID()},
      clock_timestamp()+interval '10 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}')`;
      const admission = {
        organizationId: a.org,
        workspaceId: a.workspace,
        userId: a.user,
        employeeId: a.employee,
        connectionId,
        requestedTokens: 1000,
        requestedRuntimeMs: 30000,
      };
      return { a, admission, nextRunId };
    }

    async function pendingRoute(f: Awaited<ReturnType<typeof fixture>>) {
      return recordRouteDecision(
        RouteDecisionSchema.parse({
          schemaVersion: 1,
          id: randomUUID(),
          runId: f.a.rootRunId,
          organizationId: f.a.org,
          workspaceId: f.a.workspace,
          actorId: f.a.user,
          employeeId: f.a.employee,
          inputChecksum: `sha256:${'a'.repeat(64)}`,
          candidates: [
            {
              id: 'direct:synthetic',
              kind: 'direct',
              name: 'Synthetic quota test',
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
          provider: 'openai-compatible',
          model: 'synthetic-never-called',
          modelConnectionId: f.admission.connectionId,
          generation: f.a.worker.generation,
          attempt: 1,
          reasonCodes: ['direct_no_capability_match'],
          createdAt: new Date().toISOString(),
        }),
        database.db,
      );
    }
    async function unknownProjection(
      f: Awaited<ReturnType<typeof fixture>>,
      decisionId?: string,
      organizationId: string = f.a.org,
    ) {
      const id = decisionId ?? (await pendingRoute(f)).id;
      await completeRouteDecision(
        {
          organizationId,
          workspaceId: f.a.workspace,
          outcome: {
            decisionId: id,
            status: 'failed',
            inputTokens: 11,
            cachedInputTokens: 0,
            outputTokens: 2,
            costCents: null,
            usageComplete: false,
            cacheUsageKnown: false,
            errorCode: 'DSH_SERVER',
            failureCategory: null,
            completedAt: new Date().toISOString(),
          },
        },
        database.db,
      );
    }

    async function boundedInFlight(f: Awaited<ReturnType<typeof fixture>>) {
      const callId = randomUUID();
      const input = { ...f.a.base, runId: f.a.rootRunId, callId };
      const grant = await f.a.runtime.prepareModelUsage({
        ...input,
        requestedOutputTokens: 64,
      });
      await f.a.runtime.dispatchModelUsage({
        ...input,
        inputTokens: 16,
        outputTokens: grant.outputTokens,
        requestDigest: `sha256:${'b'.repeat(64)}`,
      });
      return input;
    }

    async function reservations(rootRunId: string) {
      return database.db`select metric,amount,settled_amount from allrice_assistant_usage
      where root_run_id=${rootRunId} order by call_id,metric`;
    }

    async function budgets(rootRunId: string) {
      return database.db`select metric,capacity,reserved,spent from allrice_runtime_budgets
        where root_run_id=${rootRunId} order by metric`;
    }

    it('rechecks unknown accounting committed after B read its quota and before B admission', async () => {
      const f = await fixture();
      const oldQuota = await getOrganizationModelQuota(f.a.org, database.db);
      expect(() => assertQuotaAvailable(oldQuota)).not.toThrow();
      // Deterministic A/B interleaving, without timing assumptions: A commits only
      // after B's real initial read, but before B's real locked admission method.
      await unknownProjection(f);
      expect(
        await getOrganizationModelQuota(f.a.org, database.db),
      ).toMatchObject({
        usageComplete: false,
        unknownCostRuns: 1,
        usedCostCents: null,
      });
      expect(() => assertQuotaAvailable(oldQuota)).not.toThrow();
      await expect(admitModelExecution(f.admission)).rejects.toMatchObject({
        code: 'MODEL_TOKEN_USAGE_UNKNOWN',
      });
    });

    it('the existing fresh quota check already rejects a committed unknown projection', async () => {
      const f = await fixture();
      await unknownProjection(f);
      const quota = await getOrganizationModelQuota(f.a.org, database.db);
      expect(() => assertQuotaAvailable(quota)).toThrow(
        'MODEL_TOKEN_USAGE_UNKNOWN',
      );
    });

    it.each(['terminal', 'expired'] as const)(
      'refuses a new Run after a %s assistant root retains real unknown holds without a route projection',
      async (rootState) => {
        const f = await fixture();
        const call = await boundedInFlight(f);
        if (rootState === 'terminal') {
          // A provider finished without usage. Only the known call count settles;
          // unknown token holds are not zeroed merely because execution has stopped.
          await f.a.runtime.settleUsage({
            ...call,
            amounts: { model_calls: 1, tool_calls: 0 },
          });
          await f.a.runtime.cancelRoot(f.a.context, {
            runId: f.a.rootRunId,
            requestId: randomUUID(),
          });
          await f.a.runtime.confirmStopped({
            ...f.a.base,
            runId: f.a.rootRunId,
          });
        } else {
          // Simulated process/lease loss before final accounting projection. This
          // changes only this random fixture's live job and uses actual fencing.
          await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.a.worker.jobId}`;
          expect(await f.a.runtime.quarantineExpired(f.a.base)).toMatchObject({
            replay: false,
            requiresReconciliation: true,
          });
        }
        const before = await reservations(f.a.rootRunId);
        const beforeBudgets = await budgets(f.a.rootRunId);
        expect(before).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              metric: 'input_tokens',
              amount: '16',
              settled_amount: null,
            }),
            expect.objectContaining({
              metric: 'output_tokens',
              amount: '64',
              settled_amount: null,
            }),
          ]),
        );
        expect(
          await database.db`select id from allrice_route_decisions where run_id=${f.a.rootRunId}`,
        ).toHaveLength(0);
        expect(
          await database.db`select id from allrice_model_usage_ledger where organization_id=${f.a.org}`,
        ).toHaveLength(0);
        try {
          await expect(admitModelExecution(f.admission)).rejects.toMatchObject({
            code: 'MODEL_TOKEN_USAGE_UNKNOWN',
          });
        } finally {
          expect(await reservations(f.a.rootRunId)).toEqual(before);
          expect(await budgets(f.a.rootRunId)).toEqual(beforeBudgets);
        }
      },
    );

    it('does not classify a live bounded in-flight reservation as an orphan unknown', async () => {
      const f = await fixture();
      const call = await boundedInFlight(f);
      const [admission] =
        await database.db`select dispatched_at,finished_at from allrice_assistant_model_admissions where call_id=${call.callId}`;
      expect(admission!.dispatched_at).toBeInstanceOf(Date);
      expect(admission!.finished_at).toBeNull();
      const before = await reservations(f.a.rootRunId);
      await expect(admitModelExecution(f.admission)).resolves.toHaveLength(4);
      expect(await reservations(f.a.rootRunId)).toEqual(before);
    });

    it('does not classify preparation without dispatch as an executed unknown after the root stops', async () => {
      const f = await fixture();
      const callId = randomUUID();
      await f.a.runtime.prepareModelUsage({
        ...f.a.base,
        runId: f.a.rootRunId,
        callId,
        requestedOutputTokens: 64,
      });
      await f.a.runtime.cancelRoot(f.a.context, {
        runId: f.a.rootRunId,
        requestId: randomUUID(),
      });
      await f.a.runtime.confirmStopped({
        ...f.a.base,
        runId: f.a.rootRunId,
      });
      const [admission] =
        await database.db`select dispatched_at from allrice_assistant_model_admissions where call_id=${callId}`;
      expect(admission!.dispatched_at).toBeNull();
      const before = await reservations(f.a.rootRunId);
      expect(before).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metric: 'output_tokens',
            amount: '64',
            // Confirmed stop releases a preparation that never dispatched.
            settled_amount: '0',
          }),
        ]),
      );
      await expect(admitModelExecution(f.admission)).resolves.toHaveLength(4);
      expect(await reservations(f.a.rootRunId)).toEqual(before);
    });

    it('detects a replaced job lease without reviving the prior dispatched holds', async () => {
      const f = await fixture();
      await boundedInFlight(f);
      const before = await reservations(f.a.rootRunId);
      const beforeBudgets = await budgets(f.a.rootRunId);
      await database.db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.a.worker.jobId}`;
      await expect(admitModelExecution(f.admission)).rejects.toMatchObject({
        code: 'MODEL_TOKEN_USAGE_UNKNOWN',
      });
      expect(await reservations(f.a.rootRunId)).toEqual(before);
      expect(await budgets(f.a.rootRunId)).toEqual(beforeBudgets);
    });

    it.each(['projection', 'orphan'] as const)(
      'does not let tenant A %s block tenant B admission',
      async (kind) => {
        const a = await fixture();
        const b = await fixture();
        if (kind === 'projection') {
          await unknownProjection(a);
        } else {
          await boundedInFlight(a);
          await a.a.runtime.cancelRoot(a.a.context, {
            runId: a.a.rootRunId,
            requestId: randomUUID(),
          });
          await a.a.runtime.confirmStopped({
            ...a.a.base,
            runId: a.a.rootRunId,
          });
        }
        await expect(admitModelExecution(a.admission)).rejects.toMatchObject({
          code: 'MODEL_TOKEN_USAGE_UNKNOWN',
        });
        await expect(admitModelExecution(b.admission)).resolves.toHaveLength(4);
      },
    );

    it.each(['writer', 'admission'] as const)(
      'takes tenant before route locks and blocks B until unknown A commits with an uppercase %s UUID',
      async (uppercaseSide) => {
        const f = await fixture();
        const route = await pendingRoute(f);
        const oldQuota = await getOrganizationModelQuota(f.a.org, database.db);
        expect(() => assertQuotaAvailable(oldQuota)).not.toThrow();
        const key = `tenant:${f.a.org}`;
        async function tenantLocks(granted: boolean) {
          const [row] = await database.db`select count(*) as count from pg_locks
          where locktype='advisory' and objsubid=1 and granted=${granted}
          and classid::bigint=((hashtext(${key})::bigint >> 32) & 4294967295)
          and objid::bigint=(hashtext(${key})::bigint & 4294967295)`;
          return Number(row!.count);
        }
        let release!: () => void;
        let locked!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          locked = resolve;
        });
        // Hold only this fixture's pending route row. The actual outcome writer
        // must acquire tenant first and then wait here; no production port is mocked.
        const blocker = database.db.begin(async (tx) => {
          await tx`select id from allrice_route_decisions where id=${route.id} for update`;
          locked();
          await released;
        });
        await ready;
        let writing: Promise<void> | undefined;
        let admitting: ReturnType<typeof admitModelExecution> | undefined;
        try {
          writing = unknownProjection(
            f,
            route.id,
            uppercaseSide === 'writer' ? f.a.org.toUpperCase() : f.a.org,
          );
          void writing.catch(() => {});
          await expect.poll(() => tenantLocks(true), { timeout: 3000 }).toBe(1);
          admitting = admitModelExecution({
            ...f.admission,
            organizationId:
              uppercaseSide === 'admission' ? f.a.org.toUpperCase() : f.a.org,
          });
          void admitting.catch(() => {});
          // Demonstrates a real PostgreSQL lock wait, not a timed artificial sleep.
          await expect
            .poll(() => tenantLocks(false), { timeout: 3000 })
            .toBe(1);
          release();
          await blocker;
          await writing;
          await expect(admitting).rejects.toMatchObject({
            code: 'MODEL_TOKEN_USAGE_UNKNOWN',
          });
          expect(
            await getOrganizationModelQuota(f.a.org, database.db),
          ).toMatchObject({
            usageComplete: false,
            unknownCostRuns: 1,
          });
        } finally {
          release();
          await blocker;
          await writing?.catch(() => {});
          await admitting?.catch(() => {});
        }
      },
    );
  },
);
