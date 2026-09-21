import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { repairStoppedAssistantUsage } from './assistant-usage-repair.ts';
import {
  getOrganizationModelQuota,
  assertQuotaAvailable,
} from './providers/model-governance.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('MET-144 failure accounting — isolated real PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    database = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    await database?.close();
    vi.unstubAllEnvs();
  });
  async function setup() {
    const f = await assistantFixture(database.db);
    const prepare = async (runId: string = f.task.runId) => {
      const callId = randomUUID();
      await f.runtime.prepareModelUsage({
        ...f.base,
        runId,
        callId,
        requestedOutputTokens: 4000,
      });
      return {
        ...f.base,
        runId,
        callId,
        inputTokens: 100,
        outputTokens: 4000,
        requestDigest: `sha256:${'a'.repeat(64)}`,
      };
    };
    const settle = async (callId: string) =>
      f.runtime.settleUsage({
        ...f.base,
        callId,
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          input_tokens: 20,
          output_tokens: 7,
        },
      });
    const first = await prepare();
    await f.runtime.dispatchModelUsage(first);
    await settle(first.callId);
    const cancel = () =>
      f.runtime.cancelRoot(f.context, {
        runId: f.task.runId,
        requestId: randomUUID(),
      });
    const stop = (runId: string = f.task.runId) =>
      f.runtime.confirmStopped({ ...f.base, runId });
    const usage = () => f.runtime.readFailureUsage(f.base);
    return { f, prepare, settle, cancel, stop, usage };
  }
  async function historical() {
    const s = await setup();
    const { f } = s;
    const pending = await s.prepare();
    await s.cancel();
    // Simulate the old binary's stopped receipt without the new hold release.
    await database.db`update allrice_assistant_instances set status='canceled',stopped_at=clock_timestamp() where run_id=${f.task.runId}`;
    await database.db`update allrice_jobs set status='failed' where id=${f.worker.jobId}`;
    await database.db`update allrice_runs set state='failed' where id=${f.task.runId}`;
    const decisionId = randomUUID();
    await database.db`insert into allrice_route_decisions(id,organization_id,workspace_id,actor_id,employee_id,run_id,input_checksum,candidates,selected_kind,selected_candidate_id,harness,provider,model,generation,attempt,reason_codes,status,cost_cents,usage_complete,cache_usage_known,created_at,completed_at,error_code)
      select ${decisionId},${f.context.organizationId},${f.context.workspaceId!},${f.context.actor.id},e.id,${f.task.runId},${`sha256:${'a'.repeat(64)}`},'[]','direct','synthetic','dsh','openai-codex','synthetic',1,1,'[]','failed',null,false,false,clock_timestamp()-interval '1 minute',clock_timestamp(),'DSH_UNKNOWN' from allrice_employees e where e.organization_id=${f.context.organizationId} limit 1`;
    await database.db`insert into allrice_route_subscription_snapshots(route_decision_id,snapshot,snapshot_digest) values(${decisionId},'{"version":1,"billingMode":"subscription","harness":"dsh","provider":"openai-codex","authMode":"chatgpt_subscription","baseUrl":null}',${`sha256:${'a'.repeat(64)}`})`;
    await database.db`insert into allrice_model_usage_ledger(id,organization_id,workspace_id,route_decision_id,status,input_tokens,cached_input_tokens,output_tokens,cost_cents,usage_complete,cache_usage_known) values(${randomUUID()},${f.context.organizationId},${f.context.workspaceId!},${decisionId},'failed',0,0,0,null,false,false)`;
    vi.stubEnv(
      'ALLRICE_PLATFORM_ADMIN_EMAILS',
      `${f.context.actor.id}@example.test`,
    );
    const input = { context: f.context, runId: f.task.runId, decisionId };
    return {
      ...s,
      pending,
      input,
      repair: (expectedEvidenceDigest?: string) =>
        repairStoppedAssistantUsage(
          { ...input, expectedEvidenceDigest },
          database.db,
        ),
    };
  }
  it('historical repair is dry-run first, audit-preserving, quota-neutral and cannot be replayed', async () => {
    const h = await historical();
    const read = () =>
      getOrganizationModelQuota(h.f.context.organizationId, database.db);
    const beforeQuota = await read();
    expect(() => assertQuotaAvailable(beforeQuota, 'subscription')).toThrow(
      'MODEL_TOKEN_USAGE_UNKNOWN',
    );
    const preview = await h.repair();
    expect(preview).toMatchObject({
      applied: false,
      unusedCalls: 1,
      usage: { inputTokens: 20, outputTokens: 7 },
      usageComplete: true,
      cacheUsageKnown: false,
    });
    expect((await read()).usageComplete).toBe(false);
    await expect(h.repair(`sha256:${'f'.repeat(64)}`)).rejects.toThrow(
      'evidence_changed',
    );
    expect(await h.repair(preview.evidenceDigest)).toMatchObject({
      ...preview,
      applied: true,
    });
    const quota = await read();
    expect(quota).toMatchObject({
      usedTokens: 27,
      usageComplete: true,
      cacheUsageKnown: false,
      monthlyTokenLimit: beforeQuota.monthlyTokenLimit,
    });
    expect(() => assertQuotaAvailable(quota, 'subscription')).not.toThrow();
    const [audit] =
      await database.db`select metadata from allrice_audit_events where resource_id=${h.input.decisionId} and action='model_usage.assistant_reconciliation'`;
    expect(audit!.metadata.before.ledger).toMatchObject({
      usage_complete: false,
      input_tokens: 0,
    });
    expect(audit!.metadata.after.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 7,
    });
    const [route] =
      await database.db`select status,error_code,completed_at from allrice_route_decisions where id=${h.input.decisionId}`;
    expect(route).toMatchObject({
      status: 'failed',
      error_code: 'DSH_UNKNOWN',
    });
    expect(route!.completed_at.toISOString()).toBe(
      audit!.metadata.before.decision.completed_at,
    );
    await expect(h.repair(preview.evidenceDigest)).rejects.toThrow(
      'not_proven',
    );
    expect(
      await database.db`select 1 from allrice_audit_events where resource_id=${h.input.decisionId} and action='model_usage.assistant_reconciliation'`,
    ).toHaveLength(1);
  });
  it.each([
    'nonadmin',
    'foreign',
    'active',
    'not_stopped',
    'unknown_sent',
    'budget_mismatch',
    'changed_evidence',
  ] as const)('refuses historical repair with %s evidence', async (mode) => {
    const h = await historical();
    const preview = await h.repair();
    if (mode === 'nonadmin')
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', 'nobody@example.test');
    if (mode === 'foreign')
      h.input.context = { ...h.input.context, workspaceId: randomUUID() };
    if (mode === 'active')
      await database.db`update allrice_jobs set status='running' where id=${h.f.worker.jobId}`;
    if (mode === 'not_stopped')
      await database.db`update allrice_assistant_instances set stopped_at=null where root_run_id=${h.f.task.rootRunId}`;
    if (mode === 'unknown_sent')
      await database.db`update allrice_assistant_model_admissions set dispatched_at=prepared_at,input_tokens=100,request_digest=${`sha256:${'a'.repeat(64)}`} where call_id=${h.pending.callId}`;
    if (mode === 'budget_mismatch')
      await database.db`update allrice_runtime_budgets set reserved=reserved+1 where root_run_id=${h.f.task.rootRunId} and metric='input_tokens'`;
    if (mode === 'changed_evidence')
      await database.db`update allrice_runtime_budgets set capacity=capacity+1 where root_run_id=${h.f.task.rootRunId} and metric='input_tokens'`;
    await expect(h.repair(preview.evidenceDigest)).rejects.toThrow();
    const [ledger] =
      await database.db`select usage_complete,input_tokens from allrice_model_usage_ledger where route_decision_id=${h.input.decisionId}`;
    expect(ledger).toEqual({ usage_complete: false, input_tokens: 0 });
    expect(
      await database.db`select 1 from allrice_audit_events where resource_id=${h.input.decisionId} and action='model_usage.assistant_reconciliation'`,
    ).toHaveLength(0);
  });
  it('releases only proven undispatched preparation after stop; prior real usage survives and the call never replays', async () => {
    const { f, prepare, cancel, stop, usage } = await setup();
    const call = await prepare();
    await expect(
      f.runtime.dispatchModelUsage({ ...call, inputTokens: 100001 }),
    ).rejects.toThrow('budget_exhausted');
    expect(await usage()).toMatchObject({
      usageComplete: false,
      usage: { inputTokens: 20, outputTokens: 7 },
    });
    await expect(stop()).rejects.toThrow('conflict');
    await cancel();
    expect((await usage()).usageComplete).toBe(false);
    await stop();
    expect(await usage()).toEqual({
      usage: { inputTokens: 20, outputTokens: 7, cachedInputTokens: 0 },
      usageComplete: true,
      cacheUsageKnown: false,
    });
    const [admission] =
      await database.db`select dispatched_at,finished_at from allrice_assistant_model_admissions where call_id=${call.callId}`;
    expect(admission).toEqual({ dispatched_at: null, finished_at: null });
    const holds =
      await database.db`select settled_amount from allrice_assistant_usage where call_id=${call.callId}`;
    expect(holds).toHaveLength(4);
    expect(holds.every((h) => Number(h.settled_amount) === 0)).toBe(true);
    const before = (await f.runtime.getTree(f.context, { runId: f.task.runId }))
      .budgets;
    await stop();
    expect(
      (await f.runtime.getTree(f.context, { runId: f.task.runId })).budgets,
    ).toEqual(before);
    expect(before.every((b) => b.reserved === 0)).toBe(true);
    await expect(f.runtime.dispatchModelUsage(call)).rejects.toThrow(
      'canceled',
    );
    await expect(
      f.runtime.prepareModelUsage({
        ...f.base,
        runId: f.task.runId,
        callId: call.callId,
        requestedOutputTokens: 4000,
      }),
    ).rejects.toThrow('canceled');
    await expect(
      f.runtime.settleUsage({
        ...f.base,
        callId: call.callId,
        amounts: { model_calls: 1, input_tokens: 0, output_tokens: 0 },
      }),
    ).rejects.toThrow('conflict');
  });
  it('does not release dispatched missing receipts, legacy model or tool uncertainty; still returns prior confirmed usage', async () => {
    const { f, prepare, cancel, stop, usage } = await setup();
    const sent = await prepare();
    await f.runtime.dispatchModelUsage(sent);
    await f.runtime.reserveUsage({
      ...f.base,
      runId: f.task.runId,
      callId: randomUUID(),
      kind: 'tool',
      tool: 'read',
      amounts: {
        model_calls: 0,
        tool_calls: 1,
        input_tokens: 0,
        output_tokens: 0,
      },
    });
    await f.runtime.reserveUsage({
      ...f.base,
      runId: f.task.runId,
      callId: randomUUID(),
      kind: 'model',
      amounts: {
        model_calls: 1,
        tool_calls: 0,
        input_tokens: 50,
        output_tokens: 100,
      },
    });
    const before = (await f.runtime.getTree(f.context, { runId: f.task.runId }))
      .budgets;
    await cancel();
    await stop();
    expect(
      (await f.runtime.getTree(f.context, { runId: f.task.runId })).budgets,
    ).toEqual(before);
    expect(await usage()).toMatchObject({
      usageComplete: false,
      usage: { inputTokens: 20, outputTokens: 7 },
    });
  });
  it('requires all children idle, releasing an unused launch and child preparation exactly once', async () => {
    const { f, prepare, cancel, stop, usage } = await setup();
    const a = (await f.delegate()).instance;
    const b = (await f.delegate()).instance;
    await prepare(b.runId);
    await cancel();
    await stop();
    expect((await usage()).usageComplete).toBe(false);
    await stop(a.runId);
    expect((await usage()).usageComplete).toBe(false);
    await stop(b.runId);
    expect((await usage()).usageComplete).toBe(true);
    await stop(a.runId);
    expect(
      (
        await f.runtime.getTree(f.context, { runId: f.task.runId })
      ).budgets.every((b) => b.reserved === 0),
    ).toBe(true);
  });
  it.each(['dispatch-first', 'cancel-first'] as const)(
    'serializes %s without freeing a dispatched call or permitting replay',
    async (mode) => {
      const { f, prepare, cancel, stop, usage } = await setup();
      const call = await prepare();
      if (mode === 'dispatch-first') await f.runtime.dispatchModelUsage(call);
      else await cancel();
      await Promise.allSettled([f.runtime.dispatchModelUsage(call), cancel()]);
      await stop();
      const [admission] =
        await database.db`select dispatched_at from allrice_assistant_model_admissions where call_id=${call.callId}`;
      expect(!!admission!.dispatched_at).toBe(mode === 'dispatch-first');
      expect((await usage()).usageComplete).toBe(mode === 'cancel-first');
      await expect(f.runtime.dispatchModelUsage(call)).rejects.toThrow(
        'canceled',
      );
    },
  );
  it('cannot read/settle another scope, replacement worker, or expired lease; a revoked user grant cannot prevent safe accounting', async () => {
    const { f, prepare, cancel, stop, usage } = await setup();
    await prepare();
    await cancel();
    await expect(
      f.runtime.readFailureUsage({
        ...f.base,
        scope: { ...f.task.scope, workspaceId: randomUUID() },
      }),
    ).rejects.toThrow('not_found');
    for (const worker of [
      { ...f.worker, leaseToken: randomUUID() },
      { ...f.worker, generation: 2 },
      { ...f.worker, fence: 2 },
    ]) {
      await expect(
        f.runtime.confirmStopped({ ...f.base, runId: f.task.runId, worker }),
      ).rejects.toThrow('lease_lost');
      await expect(
        f.runtime.readFailureUsage({ ...f.base, worker }),
      ).rejects.toThrow('lease_lost');
    }
    f.revoke();
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    try {
      await stop();
      expect((await usage()).usageComplete).toBe(true);
    } finally {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    }
    await database.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
    await expect(usage()).rejects.toThrow('lease_lost');
  });
});
