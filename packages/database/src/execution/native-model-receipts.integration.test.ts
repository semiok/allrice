// @ts-expect-error The shared actual Host fixture is JavaScript.
import * as NativeHost from '../../../../apps/worker/test/native-subagent/fixture.mjs';
const { gate, host, text } = NativeHost;
/** Real isolated PostgreSQL and Worker receipt entrypoints. The added end-to-end
 * case runs the actual DSH Host; only its provider and tokens are synthetic. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  RouteDecisionSchema,
  type EmployeeRuntimePackage,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createRunAuthorityFixture } from '../run-authority.fixture.ts';
import { prepareRunMemoryContext } from '../run-memory-context.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  nativeBindingDescriptor,
  nativeBindingWaiter,
} from '../native-session-binding.fixture.ts';
import { buildEmployeeRuntimePackage } from '../platform-employees/runtime-package.ts';
import {
  acquireConversationRuntime,
  listDshRuntimeEventTimeline,
} from '../conversation/conversation-runtime.ts';
import {
  appendJobEvent,
  appendNativeModelReceipt,
  bindJobNativeSession,
  cancelRun,
  completeJob,
  finishJobDrain,
} from './queue.ts';
import {
  recordRouteDecision,
  completeRouteDecision,
} from './route-decision.ts';
import {
  NativeModelReceiptSchema,
  type NativeModelFact,
} from './native-model-receipts.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET229 immutable native model facts — isolated PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let runtimePackage: EmployeeRuntimePackage;
  beforeEach(() => {
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'c'.repeat(64));
  });
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'c'.repeat(64));
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    const employee = await createEmployeeAdministrationFixture(fixture.db);
    runtimePackage = buildEmployeeRuntimePackage({
      revision: 1,
      definition: {
        ...employee.definition,
        capabilities: {
          ...employee.definition.capabilities,
          nativeSkillIds: [],
        },
      },
      skills: [],
    });
    // Actual INSERT barrier: lets a receipt outlive its original DB deadline.
    // Unheld keys return immediately; no product algorithm is mocked.
    await fixture.db
      .unsafe(`create function native_receipt_test_gate() returns trigger language plpgsql as $$
      begin if new.payload->>'source'='native_model_receipt_v1' then
        perform pg_advisory_xact_lock(hashtextextended(new.payload->'fact'->>'callId',9187));
      end if; return new; end $$;
      create trigger native_receipt_test_gate before insert on allrice_run_events
        for each row execute function native_receipt_test_gate();
      create function native_route_test_gate() returns trigger language plpgsql as $$
      begin if old.completed_at is null and new.completed_at is not null then
        perform pg_advisory_xact_lock(hashtextextended(new.id::text,9187));
      end if; return new; end $$;
      create trigger native_route_test_gate before update on allrice_route_decisions
        for each row execute function native_route_test_gate()`);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    const cleanup = await fixture?.close();
    expect(cleanup).toMatchObject({
      schemaRemoved: true,
      storageRemoved: true,
      databaseClosed: true,
      adminClosed: true,
    });
  });
  it.each([
    { root: true, first: 'memory' },
    { root: true, first: 'receipt' },
    { root: false, first: 'receipt' },
  ] as const)(
    'serializes native receipts with real memory preparation, root=$root, $first first',
    async ({ root, first }) => {
      const f = await setup(root);
      await fixture.db`update allrice_employee_runs set status='running' where run_id=${f.rootRunId}`;
      expect(
        await fixture.db`select root_run_id from allrice_runtime_roots where root_run_id=${f.rootRunId}`,
      ).toHaveLength(root ? 1 : 0);
      const auth = {
        scope: {
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          sessionId: f.session,
          runId: f.rootRunId,
        },
        worker: { ...f.worker, attempt: 1 },
      };
      // Prove the public entry accepts this fixture before opening the lock window.
      expect(await prepareRunMemoryContext(auth, [])).toEqual([]);
      const call = start(f);
      await write(f, call);
      const gate = await fixture.db.reserve();
      await gate`begin`;
      const [held] = await gate`select pg_backend_pid() pid`;
      const send = () =>
        write(f, finish(call)).then(
          () => 'committed',
          (error: unknown) => error,
        );
      const prepare = () =>
        prepareRunMemoryContext(auth, []).then(
          () => 'prepared',
          (error: unknown) => error,
        );
      let writing: Promise<unknown> | undefined;
      let preparing: Promise<unknown> | undefined;
      try {
        if (first === 'receipt') {
          await gate`select id from allrice_route_decisions where id=${f.decision.id} for update`;
          writing = send();
          const writer = await nativeBindingWaiter(
            fixture.db,
            held!.pid as number,
          );
          preparing = prepare();
          if (root) {
            // Keep the existing root NOWAIT denial; do not retry it into success.
            expect(await preparing).toMatchObject({
              message: 'employee_access_busy',
            });
          } else {
            await nativeBindingWaiter(fixture.db, writer);
          }
          await gate`select id from allrice_runs where id=${f.rootRunId} for update nowait`;
        } else {
          await gate`select id from allrice_users where id=${f.user} for update`;
          preparing = prepare();
          const reader = await nativeBindingWaiter(
            fixture.db,
            held!.pid as number,
          );
          writing = send();
          const writer = await nativeBindingWaiter(fixture.db, reader);
          const [blocked] =
            await fixture.db`select query from pg_stat_activity where pid=${writer}`;
          expect(blocked!.query).toContain('allrice_runtime_roots');
        }
      } finally {
        await gate`rollback`;
        gate.release();
        await Promise.all([writing, preparing]);
      }
      expect(await writing).toBe('committed');
      if (!root || first === 'memory') expect(await preparing).toBe('prepared');
      expect(await read(f)).toHaveLength(2);
    },
    30000,
  );
  async function route(
    f: Awaited<ReturnType<typeof createRunAuthorityFixture>>,
    attempt = 1,
    generation = 1,
  ) {
    return recordRouteDecision(
      RouteDecisionSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        runId: f.rootRunId,
        organizationId: f.org,
        workspaceId: f.workspace,
        actorId: f.user,
        employeeId: f.employee,
        inputChecksum: 'sha256:' + '3'.repeat(64),
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
        provider: 'synthetic',
        model: 'never-called',
        generation,
        attempt,
        reasonCodes: ['direct_no_capability_match'],
        createdAt: new Date().toISOString(),
      }),
    );
  }
  async function setup(configure = true) {
    const f = await createRunAuthorityFixture(fixture.db, {
      runtimePackage,
      configure,
      businessCreationOrigin: true,
    });
    await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
    f.context.memberships = [
      {
        id: f.membership,
        userId: f.user,
        organizationId: f.org,
        workspaceId: f.workspace,
        role: 'admin',
        active: true,
      },
    ];
    const [runtime] =
      await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
    const descriptor = nativeBindingDescriptor({
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      contextKey: f.session,
    });
    await bindJobNativeSession({
      workerId: f.worker.workerId,
      jobId: f.worker.jobId,
      leaseToken: f.worker.leaseToken,
      attempt: 1,
      subject: {
        kind: 'chat',
        id: f.session,
        configChecksum: runtime!.config_checksum,
        generation: runtime!.thread_generation,
        expectedThreadId: runtime!.thread_id,
      },
      descriptor,
    });
    const decision = await route(f);
    return { ...f, descriptor, decision };
  }
  type Fixture = Awaited<ReturnType<typeof setup>>;
  const start = (
    f: Fixture,
    overrides: Partial<Extract<NativeModelFact, { phase: 'start' }>> = {},
  ) => ({
    phase: 'start' as const,
    callId: randomUUID(),
    nativeSessionId: f.descriptor.nativeSessionId,
    provider: 'synthetic',
    model: 'never-called',
    ...overrides,
  });
  const finish = (
    fact: ReturnType<typeof start>,
  ): Extract<NativeModelFact, { phase: 'finish' }> => ({
    ...fact,
    phase: 'finish',
    outcome: 'succeeded',
    usageComplete: true,
    usage: {
      inputTokens: 100,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      outputTokens: 5,
    },
  });
  const write = (
    f: Fixture,
    fact: NativeModelFact,
    decisionId = f.decision.id,
  ) =>
    appendNativeModelReceipt({
      ...f.worker,
      rootSessionId: f.descriptor.nativeSessionId,
      routeDecisionId: decisionId,
      fact,
    });
  const read = async (f: Fixture, decisionId = f.decision.id) => {
    const rows = await fixture.db`select payload from allrice_run_events
      where run_id=${f.rootRunId} and payload->>'source'='native_model_receipt_v1'
      order by sequence`;
    return rows
      .map((row) => NativeModelReceiptSchema.parse(row.payload))
      .filter((row) => row.routeDecisionId === decisionId);
  };
  const settle = (f: Fixture) =>
    completeRouteDecision({
      organizationId: f.org,
      workspaceId: f.workspace,
      outcome: {
        decisionId: f.decision.id,
        status: 'failed',
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: null,
        usageComplete: false,
        cacheUsageKnown: false,
        errorCode: 'synthetic_stop',
        failureCategory: null,
        completedAt: new Date().toISOString(),
      },
    }).then(
      () => ({ closed: true }),
      (error) => ({ error }),
    );
  async function held(callId: string) {
    const connection = await fixture.db.reserve();
    const [r] =
      await connection`select pg_backend_pid() pid,pg_advisory_lock(hashtextextended(${callId},9187))`;
    return {
      pid: r!.pid as number,
      release: async () => {
        await connection`select pg_advisory_unlock(hashtextextended(${callId},9187))`;
        connection.release();
      },
    };
  }
  async function followup(f: Fixture) {
    const runId = randomUUID(),
      jobId = randomUUID(),
      workerId = randomUUID(),
      leaseToken = randomUUID();
    const um = randomUUID(),
      am = randomUUID();
    await completeJob({
      ...f.worker,
      result: { text: 'Synthetic previous turn' },
    });
    await fixture.db.begin(async (tx) => {
      // Arrange a later turn as in the native binding fixture, without running a model.
      await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
        values(${runId},${f.org},${f.workspace},${f.user},'running','{}','{}')`;
      await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,attempt,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
        values(${jobId},${f.org},${f.workspace},${f.user},${runId},'running',${randomUUID()},1,clock_timestamp()+interval '10 minutes',
          '{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${workerId},${leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes')`;
      await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
        values(${um},${f.org},${f.workspace},${f.session},${f.user},'user','{}'),(${am},${f.org},${f.workspace},${f.session},${f.user},'assistant','{}')`;
      await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot)
        select ${runId},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,${um},${am},provider_snapshot,prompt_snapshot,native_skills,execution_snapshot
        from allrice_employee_runs where run_id=${f.rootRunId}`;
    });
    const runtime = await acquireConversationRuntime({
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      sessionId: f.session,
      runId,
      workerId,
      configChecksum: runtimePackage.checksum,
      compactThresholdTokens: 4096,
    });
    const worker = {
      jobId,
      workerId,
      leaseToken,
      generation: runtime.generation,
    };
    await bindJobNativeSession({
      workerId,
      jobId,
      leaseToken,
      attempt: 1,
      descriptor: f.descriptor,
      subject: {
        kind: 'chat',
        id: f.session,
        configChecksum: runtime.configChecksum,
        generation: runtime.generation,
        expectedThreadId: runtime.threadId,
      },
    });
    const next = {
      ...f,
      rootRunId: runId,
      task: { ...f.task, runId, rootRunId: runId },
      worker,
    };
    return { ...next, decision: await route(next, 1, runtime.generation) };
  }

  function nativeOutcome(
    f: Fixture,
    delivery = { calls: 1, complete: true },
    price: {
      inputCentsPerMillion: number;
      outputCentsPerMillion: number;
    } | null = { inputCentsPerMillion: 100, outputCentsPerMillion: 400 },
  ) {
    return completeRouteDecision({
      organizationId: f.org,
      workspaceId: f.workspace,
      native: {
        rootSessionId: f.descriptor.nativeSessionId,
        jobId: f.worker.jobId,
        jobAttempt: 1,
        delivery,
        price: price ?? undefined,
      },
      outcome: {
        decisionId: f.decision.id,
        status: 'succeeded',
        inputTokens: 999999,
        cachedInputTokens: 0,
        outputTokens: 999999,
        costCents: 999999,
        usageComplete: true,
        cacheUsageKnown: true,
        errorCode: null,
        failureCategory: null,
        completedAt: new Date().toISOString(),
      },
    });
  }
  it('用户委派后只把实际 root/child/fork 新调用记入原根账单，不重计继承前缀', async () => {
    const f = await setup();
    let delivery = { calls: 0, complete: false };
    const childEntered = gate(),
      childRelease = gate();
    const h = await host({
      accounting: true,
      runId: f.rootRunId,
      rootId: f.descriptor.nativeSessionId,
      provider: 'synthetic',
      modelName: 'never-called',
      depth: 2,
      model: async (_request: unknown, count: number) => {
        if (count === 2) {
          childEntered.resolve();
          await childRelease.promise;
        }
        return text('完成');
      },
      usage: {
        inputTokens: 1000,
        cacheReadTokens: 2000,
        cacheWriteTokens: 500,
        outputTokens: 100,
      },
      bridge: async (method: string, p: Record<string, any>) => {
        if (method === 'allrice/run-authorize') return { allowed: true };
        if (method !== 'allrice/model-receipt') throw Error(method);
        expect(p.rootSessionId).toBe(f.descriptor.nativeSessionId);
        expect(p.runId).toBe(f.rootRunId);
        if (p.fact) await write(f, p.fact);
        else delivery = p.delivery;
        return {};
      },
    });
    await h.prompt('把主任务和委派的新调用用量归根，不重复收费。');
    await h.wait();
    const child = await h.spawn();
    await childEntered.promise;
    try {
      const grandchild = await h.spawn(
        h.ctx.agents.get(child.childId),
        '孙任务',
      );
      await grandchild.result;
    } finally {
      childRelease.resolve();
    }
    await child.result;
    await h.wait();
    const fork = await h.spawn(h.root, '从已有上下文完成新子任务', {
      provider: 'fork',
    });
    await fork.result;
    await h.wait();
    await h.server.handleRequest('run/end', { runId: f.rootRunId });
    const receipts = await read(f);
    expect(receipts.filter((p) => p.fact.phase === 'start')).toHaveLength(
      h.calls.length,
    );
    expect(new Set(receipts.map((p) => p.fact.nativeSessionId)).size).toBe(4);
    expect(delivery).toEqual({ calls: h.calls.length, complete: true });
    const settled = await nativeOutcome(f, delivery);
    expect(settled).toMatchObject({
      inputTokens: 3500 * h.calls.length,
      cachedInputTokens: 2000 * h.calls.length,
      outputTokens: 100 * h.calls.length,
      usageComplete: true,
      cacheUsageKnown: true,
    });
    expect(settled?.costCents).toBeCloseTo(0.19 * h.calls.length);
    const [ledger] =
      await fixture.db`select * from allrice_model_usage_ledger where route_decision_id=${f.decision.id}`;
    expect(Number(ledger!.cost_cents)).toBeCloseTo(0.19 * h.calls.length);
    expect(
      await fixture.db`select * from allrice_employee_run_steps where run_id=${f.rootRunId} and payload->>'source'='native_model_receipt_v1'`,
    ).toHaveLength(0);
    expect(
      await nativeOutcome(f, delivery, {
        inputCentsPerMillion: 999999,
        outputCentsPerMillion: 999999,
      }),
    ).toEqual(settled);
  }, 30000);
  it('retains complete tokens but unknown cost when this Run has no frozen deployment tariff', async () => {
    const f = await setup(),
      call = start(f);
    await write(f, call);
    await write(f, finish(call));
    expect(
      await nativeOutcome(f, { calls: 1, complete: true }, null),
    ).toMatchObject({
      inputTokens: 130,
      cachedInputTokens: 20,
      outputTokens: 5,
      usageComplete: true,
      cacheUsageKnown: true,
      costCents: null,
    });
  });
  it.each(['delivery', 'missing-finish', 'missing-cache', 'count'] as const)(
    'keeps %s incomplete without falling back to the caller cumulative snapshot',
    async (fault) => {
      const f = await setup(),
        call = start(f);
      await write(f, call);
      if (fault !== 'missing-finish')
        await write(
          f,
          fault === 'missing-cache'
            ? {
                ...finish(call),
                usage: { inputTokens: 100, outputTokens: 5 },
                usageComplete: false,
              }
            : finish(call),
        );
      const result = await nativeOutcome(f, {
        calls: fault === 'count' ? 2 : 1,
        complete: fault !== 'delivery',
      });
      expect(result?.usageComplete).toBe(false);
      expect(result?.costCents).toBeNull();
      expect(result?.inputTokens).not.toBe(999999);
    },
  );
  it('does not hide a wrong native root behind an empty fallback', async () => {
    const f = await setup(),
      call = start(f);
    await write(f, call);
    await write(f, finish(call));
    await expect(
      nativeOutcome({
        ...f,
        descriptor: { ...f.descriptor, nativeSessionId: 'wrong-root' },
      }),
    ).rejects.toThrow('NATIVE_RECEIPT_SCOPE_CONFLICT');
    expect(
      await fixture.db`select * from allrice_model_usage_ledger where route_decision_id=${f.decision.id}`,
    ).toHaveLength(0);
  });
  it('deduplicates concurrent start and finish retransmissions without adding a task clock', async () => {
    const f = await setup(),
      call = start(f);
    const starts = await Promise.all(
      Array.from({ length: 4 }, () => write(f, call)),
    );
    expect(
      starts.every(
        (receipt) => JSON.stringify(receipt) === JSON.stringify(starts[0]),
      ),
    ).toBe(true);
    const finishes = await Promise.all(
      Array.from({ length: 4 }, () => write(f, finish(call))),
    );
    expect(finishes[0]?.sourceKey).toBe(starts[0]?.sourceKey);
    expect(await read(f)).toEqual([starts[0], finishes[0]]);
    expect(
      await fixture.db`select * from allrice_task_clocks where run_id=${f.rootRunId}`,
    ).toHaveLength(0);
    expect(
      await fixture.db`select * from allrice_model_usage_ledger where route_decision_id=${f.decision.id}`,
    ).toHaveLength(0);
  });
  it('requires a matching immutable start, including provider, purpose and route attempt', async () => {
    const f = await setup(),
      call = start(f);
    await expect(write(f, finish(call))).rejects.toThrow('conflict');
    await write(f, call);
    await expect(write(f, { ...call, provider: 'different' })).rejects.toThrow(
      'conflict',
    );
    await expect(
      write(f, { ...finish(call), purpose: 'compaction' }),
    ).rejects.toThrow('conflict');
    const secondRoute = await route(f, 2);
    await expect(write(f, call, secondRoute.id)).rejects.toThrow('conflict');
    await expect(write(f, finish(call), secondRoute.id)).rejects.toThrow(
      'conflict',
    );
    const done = await write(f, finish(call));
    expect(
      await write(f, {
        ...finish(call),
        usage: {
          outputTokens: 5,
          cacheWriteTokens: 10,
          inputTokens: 100,
          cacheReadTokens: 20,
        },
      }),
    ).toEqual(done);
    await expect(
      write(f, {
        ...finish(call),
        usage: { ...finish(call).usage, inputTokens: 101 },
      }),
    ).rejects.toThrow('conflict');
    expect(await read(f, secondRoute.id)).toEqual([]);
  });
  it('commits only one of two concurrently conflicting finish facts', async () => {
    const f = await setup(),
      call = start(f);
    await write(f, call);
    const outcomes = await Promise.allSettled([
      write(f, finish(call)),
      write(f, {
        ...finish(call),
        usage: { ...finish(call).usage, outputTokens: 6 },
      }),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'conflict' },
    });
    const receipts = await read(f);
    expect(receipts).toHaveLength(2);
    expect(outcomes.find((r) => r.status === 'fulfilled')).toMatchObject({
      value: receipts[1],
    });
  });
  it('keeps incomplete and zero usage distinct, and records fresh retry/compaction calls separately', async () => {
    const f = await setup();
    const interrupted = start(f, {
      nativeSessionId: 'synthetic-child-session',
    });
    await write(f, interrupted);
    await write(f, {
      ...interrupted,
      phase: 'finish',
      outcome: 'failed',
      usageComplete: false,
      usage: { inputTokens: 7 },
    });
    const retry = start(f, { nativeSessionId: interrupted.nativeSessionId });
    await write(f, retry);
    await write(f, {
      ...retry,
      phase: 'finish',
      outcome: 'succeeded',
      usageComplete: true,
      usage: {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
    });
    const compaction = start(f, { purpose: 'compaction' });
    await write(f, compaction); // A hard stop has no finish: leave exactly that fact.
    const receipts = await read(f);
    expect(receipts).toHaveLength(5);
    expect(new Set(receipts.map((r) => r.sourceKey)).size).toBe(3);
    expect(receipts[1]?.fact).toMatchObject({
      usageComplete: false,
      usage: { inputTokens: 7 },
    });
    expect(receipts[1]?.fact).not.toHaveProperty('usage.outputTokens');
    expect(receipts[3]?.fact).toMatchObject({
      usageComplete: true,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(receipts[4]?.fact.phase).toBe('start');
  });
  it('rejects unsafe usage, fake completeness and presentation fields at the private contract', async () => {
    const f = await setup(),
      call = start(f);
    for (const fact of [
      { ...finish(call), usage: undefined },
      { ...finish(call), outcome: 'incomplete' },
      { ...finish(call), usage: { inputTokens: -1 } },
      { ...finish(call), usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1 } },
      { ...call, presentation: 'tool', nativePayload: { text: 'not a fact' } },
    ])
      await expect(write(f, fact as NativeModelFact)).rejects.toThrow();
    expect(await read(f)).toEqual([]);
  });
  it('does not move a prior call into the next Run or conversation generation', async () => {
    const f = await setup(),
      call = start(f);
    const initial = await write(f, call),
      later = await followup(f);
    expect(later.worker.generation).toBeGreaterThan(f.worker.generation);
    await expect(write(later, call)).rejects.toThrow('conflict');
    await expect(write(later, finish(call))).rejects.toThrow('conflict');
    expect(await read(later)).toEqual([]);
    expect(await read(f)).toEqual([initial]);
    await expect(write(later, start(later))).resolves.toMatchObject({
      runId: later.rootRunId,
    });
  });
  it('scopes root and route writes to the leased tenant', async () => {
    const f = await setup(),
      other = await setup(),
      call = start(f);
    await write(f, call);
    await expect(
      appendNativeModelReceipt({
        ...other.worker,
        rootSessionId: f.descriptor.nativeSessionId,
        routeDecisionId: other.decision.id,
        fact: call,
      }),
    ).rejects.toThrow('policy_denied');
    await expect(write(f, start(f), other.decision.id)).rejects.toThrow(
      'policy_denied',
    );
    await expect(write(other, start(other), f.decision.id)).rejects.toThrow(
      'policy_denied',
    );
    expect(await read(other)).toEqual([]);
    // An existing pin for a different business root, with the SAME tenant and
    // owner, is not authority merely because this Worker holds some live Job.
    const unrelated = 'dsh-' + randomUUID();
    await fixture.db`insert into allrice_native_session_bindings(
      native_session_id,organization_id,workspace_id,owner_id,context_kind,context_id,
      storage_context_key,storage_namespace,artifact_id,artifact_manifest_digest,
      distribution_generation,profile_id,first_run_id,first_job_id,first_attempt,binding_basis,root_origin_digest)
      select ${unrelated},organization_id,workspace_id,owner_id,context_kind,${randomUUID()},
        ${randomUUID()},storage_namespace,artifact_id,artifact_manifest_digest,
        distribution_generation,profile_id,${randomUUID()},${randomUUID()},first_attempt,binding_basis,root_origin_digest
      from allrice_native_session_bindings where native_session_id=${f.descriptor.nativeSessionId}`;
    await expect(
      appendNativeModelReceipt({
        ...f.worker,
        rootSessionId: unrelated,
        routeDecisionId: f.decision.id,
        fact: start(f),
      }),
    ).rejects.toThrow('policy_denied');
  });
  it('finishes an admitted call during the original cancellation drain but denies new starts and post-terminal writes', async () => {
    const f = await setup(),
      call = start(f);
    await write(f, call);
    await cancelRun(f.context, f.workspace, f.rootRunId, {
      reason: 'user_requested',
    });
    await expect(write(f, start(f))).rejects.toThrow('policy_denied');
    await expect(
      write(f, {
        ...call,
        phase: 'finish',
        outcome: 'canceled',
        usageComplete: false,
      }),
    ).resolves.toMatchObject({ fact: { outcome: 'canceled' } });
    await finishJobDrain(f.worker);
    await expect(write(f, finish(call))).rejects.toThrow('lease_lost');
    expect(await read(f)).toHaveLength(2);
  });
  it.each(['lease_token', 'drain', 'lease'] as const)(
    'rejects %s revocation without fabricating a missing finish',
    async (kind) => {
      const f = await setup(),
        call = start(f);
      await write(f, call);
      if (kind === 'lease_token')
        await fixture.db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.worker.jobId}`;
      if (kind === 'drain') {
        await cancelRun(f.context, f.workspace, f.rootRunId, {
          reason: 'user_requested',
        });
        await fixture.db`update allrice_jobs set drain_deadline_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
      }
      if (kind === 'lease')
        await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
      await expect(write(f, finish(call))).rejects.toThrow('lease_lost');
      expect((await read(f)).map((r) => r.fact.phase)).toEqual(['start']);
    },
  );
  it('rolls back a real INSERT when its original receipt drain expires before commit', async () => {
    const f = await setup(),
      call = start(f);
    await write(f, call);
    await cancelRun(f.context, f.workspace, f.rootRunId, {
      reason: 'user_requested',
    });
    const gate = await held(call.callId);
    let writing: Promise<unknown> | undefined;
    try {
      const [deadline] =
        await fixture.db`update allrice_jobs set drain_deadline_at=clock_timestamp()+interval '2 seconds'
        where id=${f.worker.jobId} returning drain_deadline_at`;
      // Attach the rejection handler immediately; gate/DB-clock, not a timing guess.
      writing = write(f, finish(call)).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await nativeBindingWaiter(fixture.db, gate.pid);
      await fixture.db`select pg_sleep(greatest(0,extract(epoch from ${deadline!.drain_deadline_at}::timestamptz-clock_timestamp()))+0.02)`;
    } finally {
      await gate.release();
    }
    expect(await writing).toMatchObject({ error: { code: 'lease_lost' } });
    expect((await read(f)).map((r) => r.fact.phase)).toEqual(['start']);
  });
  it('refuses new facts after route settlement or a terminal Run event', async () => {
    const f = await setup(),
      call = start(f);
    await write(f, call);
    await completeRouteDecision({
      organizationId: f.org,
      workspaceId: f.workspace,
      outcome: {
        decisionId: f.decision.id,
        status: 'failed',
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents: null,
        usageComplete: false,
        cacheUsageKnown: false,
        errorCode: 'synthetic_stop',
        failureCategory: null,
        completedAt: new Date().toISOString(),
      },
    });
    await expect(write(f, finish(call))).rejects.toThrow('conflict');
    expect(await read(f)).toHaveLength(1);
    const open = await setup();
    await fixture.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${open.org},${open.workspace},${open.rootRunId},0,'run.failed','{}')`;
    await expect(write(open, start(open))).rejects.toThrow('conflict');
    expect(await read(open)).toEqual([]);
  });
  it('keeps route settlement behind an in-flight receipt INSERT until the fact commits', async () => {
    const f = await setup(),
      call = start(f);
    await write(f, call);
    const gate = await held(call.callId);
    let writing: Promise<unknown> | undefined,
      closing: Promise<unknown> | undefined;
    try {
      writing = write(f, finish(call)).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const writer = await nativeBindingWaiter(fixture.db, gate.pid);
      closing = settle(f);
      await nativeBindingWaiter(fixture.db, writer);
      const [route] =
        await fixture.db`select completed_at from allrice_route_decisions where id=${f.decision.id}`;
      expect(route!.completed_at).toBeNull();
      expect((await read(f)).map((r) => r.fact.phase)).toEqual(['start']);
    } finally {
      await gate.release();
      await Promise.all([writing, closing]);
    }
    expect(await writing).toMatchObject({ value: { fact: finish(call) } });
    expect(await closing).toEqual({ closed: true });
    expect((await read(f)).map((r) => r.fact.phase)).toEqual([
      'start',
      'finish',
    ]);
    await expect(write(f, start(f))).rejects.toThrow('conflict');
    // This proves the shared closure boundary, not aggregation: the legacy
    // outcome above is synthetic. The next slice must read facts under it.
  });
  it('does not acquire tenant admission while holding the leased Job', async () => {
    const f = await setup(),
      connection = await fixture.db.reserve();
    try {
      await connection`select pg_advisory_lock(hashtext(${`tenant:${f.org.toLowerCase()}`}))`;
      await expect(write(f, start(f))).resolves.toMatchObject({
        runId: f.rootRunId,
        fact: { phase: 'start' },
      });
    } finally {
      await connection`select pg_advisory_unlock(hashtext(${`tenant:${f.org.toLowerCase()}`}))`;
      connection.release();
    }
  }, 10000);
  it('rechecks closure after a real route UPDATE wins the race and rejects a late finish', async () => {
    const f = await setup(),
      call = start(f);
    await write(f, call);
    const gate = await held(f.decision.id);
    let writing: Promise<unknown> | undefined,
      closing: Promise<unknown> | undefined;
    try {
      closing = settle(f);
      const closer = await nativeBindingWaiter(fixture.db, gate.pid);
      writing = write(f, finish(call)).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await nativeBindingWaiter(fixture.db, closer);
      expect((await read(f)).map((r) => r.fact.phase)).toEqual(['start']);
    } finally {
      await gate.release();
      await Promise.all([writing, closing]);
    }
    expect(await closing).toEqual({ closed: true });
    expect(await writing).toMatchObject({ error: { code: 'conflict' } });
    expect((await read(f)).map((r) => r.fact.phase)).toEqual(['start']);
  });
  it('rolls back a new start that crosses the original job deadline during INSERT', async () => {
    const f = await setup(),
      call = start(f);
    const gate = await held(call.callId);
    let writing: Promise<unknown> | undefined;
    try {
      const [deadline] =
        await fixture.db`update allrice_jobs set timeout_at=clock_timestamp()+interval '2 seconds'
        where id=${f.worker.jobId} returning timeout_at,lease_expires_at`;
      writing = write(f, call).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await nativeBindingWaiter(fixture.db, gate.pid);
      await fixture.db`select pg_sleep(greatest(0,extract(epoch from ${deadline!.timeout_at}::timestamptz-clock_timestamp()))+0.02)`;
      const [clock] = await fixture.db`select clock_timestamp() now`;
      expect(clock!.now.getTime()).toBeGreaterThan(
        deadline!.timeout_at.getTime(),
      );
      expect(deadline!.lease_expires_at.getTime()).toBeGreaterThan(
        clock!.now.getTime(),
      );
    } finally {
      await gate.release();
      await writing;
    }
    expect(await writing).toMatchObject({ error: { code: 'policy_denied' } });
    expect(await read(f)).toEqual([]);
    const [count] =
      await fixture.db`select count(*)::int n from allrice_task_clocks where run_id=${f.rootRunId}`;
    expect(count!.n).toBe(0);
  });
  it('still accepts an existing call finish after the job deadline inside its valid lease and drain', async () => {
    const f = await setup(),
      call = start(f);
    await write(f, call);
    await cancelRun(f.context, f.workspace, f.rootRunId, {
      reason: 'user_requested',
    });
    const [window] =
      await fixture.db`update allrice_jobs set timeout_at=clock_timestamp() where id=${f.worker.jobId}
        returning timeout_at<=clock_timestamp() expired,lease_expires_at>clock_timestamp() leased,
          drain_deadline_at>clock_timestamp() draining`;
    expect(window).toMatchObject({
      expired: true,
      leased: true,
      draining: true,
    });
    const ended = { ...finish(call), outcome: 'canceled' as const };
    await expect(write(f, ended)).resolves.toMatchObject({ fact: ended });
    await expect(write(f, start(f))).rejects.toThrow('policy_denied');
    expect((await read(f)).map((r) => r.fact.phase)).toEqual([
      'start',
      'finish',
    ]);
  });
  it('keeps “把资料归纳成摘要” process cards unchanged and blocks generic native impersonation', async () => {
    const f = await setup();
    await fixture.db`update allrice_messages set content='{"text":"把资料归纳成摘要","citations":[]}'
      where id=(select user_message_id from allrice_employee_runs where run_id=${f.rootRunId})`;
    await appendJobEvent({
      ...f.worker,
      type: 'harness.native',
      payload: {
        source: 'dsh',
        presentation: 'tool',
        label: '查阅资料',
        status: 'completed',
        nativePayload: { callId: 'fixture-tool' },
      },
    });
    const before = await listDshRuntimeEventTimeline(f.session);
    expect(before.turns[0]?.userMessage.text).toBe('把资料归纳成摘要');
    expect(before.turns[0]?.events.map((e) => e.title)).toEqual(['查阅资料']);
    const call = start(f),
      receipt = await write(f, call);
    await write(f, finish(call));
    // More internal facts than the selected-Run limit must not evict a card.
    for (let i = 1; i < 75; i++) {
      const next = start(f);
      await write(f, next);
      await write(f, finish(next));
    }
    for (const type of ['harness.native', 'tool.completed'] as const) {
      await expect(
        appendJobEvent({ ...f.worker, type, payload: receipt }),
      ).rejects.toThrow('policy_denied');
    }
    const after = await listDshRuntimeEventTimeline(f.session);
    expect(after.turns[0]?.events).toEqual(before.turns[0]?.events);
    const selected = await listDshRuntimeEventTimeline(f.session, {
      runId: f.rootRunId,
    });
    expect(selected.turns[0]?.events).toEqual(before.turns[0]?.events);
    const steps =
      await fixture.db`select event_type,payload from allrice_employee_run_steps where run_id=${f.rootRunId} order by sequence`;
    expect(steps).toHaveLength(1);
    expect(steps[0]?.payload.source).toBe('dsh');
    expect(await read(f)).toHaveLength(150);
  });
  it('applies the actual partial index with historical native events and rejects a cross-Run duplicate at SQL level', async () => {
    const f = await setup(),
      call = start(f),
      receipt = await write(f, call);
    const later = await followup(f);
    const migration = await readFile(
      new URL(
        '../../migrations/0230_native_model_receipts.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await fixture.db.begin(async (tx) => {
      await tx.unsafe('drop index allrice_native_model_receipt_once');
      for (const sequence of [10, 11])
        await tx`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
        values(${f.org},${f.workspace},${f.rootRunId},${sequence},'harness.native','{"source":"dsh","nativeType":"model/usage"}')`;
      await tx.unsafe(migration);
    });
    await expect(fixture.db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      values(${later.org},${later.workspace},${later.rootRunId},0,'harness.native',${fixture.db.json(receipt)})`).rejects.toMatchObject(
      { code: '23505', constraint_name: 'allrice_native_model_receipt_once' },
    );
    expect(await read(f)).toEqual([receipt]);
    expect(await read(later)).toEqual([]);
  });
});
