/** Current human entry -> captured source -> bounded occurrence. No model/Host. */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { approveSyntheticCurrentEmployeeExecution } from './current-execution.fixture.ts';
import * as client from './core/client.ts';
import { createChatSession, sendChatMessage } from './workspace/service.ts';
import {
  startClaimedJob,
  completeJob,
  enqueueExperienceConsolidationRun,
} from './execution/queue.ts';
import { collectPendingMemorySources } from './memory-source-evidence.ts';
import {
  syncExperienceConsolidationSchedules,
  reserveExperienceOccurrenceInTransaction,
  experienceOccurrencePrincipal,
  prepareExperienceExecution,
  dispatchExperienceOccurrence,
  recoverExperienceOccurrences,
  listExperienceDrafts,
} from './experience-consolidation.ts';
import { loadPlatformContentCatalog } from './platform-content/catalog.ts';
import { synchronizePlatformContent } from './platform-content/sync.ts';
import { MemoryOccurrenceSchema } from './memory-consolidation-contracts.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  RouteDecisionSchema,
  resolveSubscriptionSnapshot,
} from '@allrice/contracts';
import {
  recordRouteDecision,
  completeRouteDecision,
} from './execution/route-decision.ts';
import { freezeRouteSubscriptionSnapshot } from './execution/route-subscription.ts';
import { providerSnapshotForModelTarget } from '../../../apps/worker/src/routing/provider-snapshot.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('M5-C current bounded consolidation, isolated SQL and no model', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let db: typeof fixture.db;
  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    db = fixture.db;
    vi.spyOn(client, 'getDatabase').mockReturnValue(db);
    approveSyntheticCurrentEmployeeExecution();
    for (const key of [
      'ALLRICE_EXPERIENCE_REVIEW_ENABLED',
      'ALLRICE_NATIVE_RECURRING_ENABLED',
      'ALLRICE_NATIVE_CALENDAR_ENABLED',
    ])
      vi.stubEnv(key, '1');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Error('No model/network in M5-C tests'),
    );
    await synchronizePlatformContent(await loadPlatformContentCatalog());
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  async function source(
    text = '合成品牌月报先列退款，再汇总净回款。',
    count = 1,
  ) {
    const f = await createExperienceFixture(db, { authenticated: true });
    const session = await createChatSession(f.owner, {
      workspaceId: f.workspace,
      title: 'Synthetic M5-C source',
    });
    let sent!: Awaited<ReturnType<typeof sendChatMessage>>;
    for (let i = 0; i < count; i++) {
      sent = await sendChatMessage(f.owner, f.workspace, session.id, {
        clientMessageId: randomUUID(),
        text,
      });
      const workerId = randomUUID(),
        leaseToken = randomUUID();
      const [job] =
        await db`update allrice_jobs set status='claimed',worker_id=${workerId},lease_token=${leaseToken},claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes' where run_id=${sent.run.id} returning id`;
      expect(await startClaimedJob(workerId, job!.id, leaseToken)).toBeTruthy();
      await completeJob({
        workerId,
        jobId: job!.id,
        leaseToken,
        result: { text: 'Synthetic assistant output is not a source' },
      });
    }
    for (let offset = 0; offset < count; offset += 16)
      await collectPendingMemorySources({ database: db, limit: 16 });
    const [e] =
      await db`select * from allrice_experience_reviews where run_id=${sent.run.id}`;
    expect(e).toBeTruthy();
    await syncExperienceConsolidationSchedules();
    const [rule] =
      await db`select * from allrice_automations where owner_id=${f.user} and experience_binding is not null`;
    expect(rule).toBeTruthy();
    const reserve = () =>
      db.begin((tx) =>
        reserveExperienceOccurrenceInTransaction(
          tx,
          rule as never,
          rule!.next_run_at,
        ),
      );
    return {
      ...f,
      e: e!,
      rule: rule!,
      reserve,
      session,
      sourceRun: sent.run.id,
    };
  }
  async function reserved() {
    const f = await source();
    const r = await f.reserve();
    expect(r.outcome).toBe('queued');
    if (!('automationRunId' in r)) throw Error('expected occurrence');
    const [row] =
      await db`select * from allrice_automation_runs where id=${r.automationRunId}`;
    return {
      ...f,
      id: r.automationRunId,
      row: row!,
      occurrence: MemoryOccurrenceSchema.parse(row!.experience_occurrence),
    };
  }
  it('uses a real human message as one source, freezes v2 and never exposes it as an old draft', async () => {
    const f = await reserved();
    expect(f.occurrence.sources.map((s) => s.excerpt)).toEqual([
      '合成品牌月报先列退款，再汇总净回款。',
    ]);
    expect(f.occurrence.sources[0]!.evidence.kind).toBe('human_message');
    expect((await experienceOccurrencePrincipal(f.id)).actor.id).toBe(f.user);
    const frozen = await prepareExperienceExecution(f.id);
    expect(frozen.schemaVersion).toBe(2);
    expect(frozen.occurrenceDigest).toBe(runtimePolicyDigest(f.occurrence));
    expect(frozen.nativeSkills.map((s) => s.name)).toEqual([
      'experience-consolidation',
    ]);
    expect(await listExperienceDrafts(f.owner)).toEqual([]);
    expect(await f.reserve()).toEqual({
      outcome: 'already_claimed',
      automationRunId: f.id,
    });
    expect(await recoverExperienceOccurrences()).toContain(f.id);
  });
  it('no eligible source creates no Run, Job, model snapshot or route', async () => {
    const f = await source();
    await db`update allrice_memories set archived_at=clock_timestamp() where id=${f.e.memory_id}`;
    const r = await f.reserve();
    expect(r.outcome).toBe('empty');
    if (!('automationRunId' in r)) throw Error('expected empty receipt');
    const [row] =
      await db`select run_id,experience_execution,error_code,status from allrice_automation_runs where id=${r.automationRunId}`;
    expect(row).toEqual({
      run_id: null,
      experience_execution: null,
      error_code: 'EXPERIENCE_NO_NEW_EVIDENCE',
      status: 'succeeded',
    });
    await expect(
      enqueueExperienceConsolidationRun(r.automationRunId),
    ).rejects.toMatchObject({ code: 'source_changed' });
  });
  it.each(['withdraw', 'text', 'membership'] as const)(
    'rechecks %s before a model can be enqueued',
    async (change) => {
      const f = await reserved();
      if (change === 'withdraw')
        await db`update allrice_memories set archived_at=clock_timestamp() where id=${f.e.memory_id}`;
      if (change === 'text')
        await db`update allrice_messages set content='{"text":"changed synthetic source"}' where id=${f.e.message_id}`;
      if (change === 'membership')
        await db`update allrice_memberships set active=false where user_id=${f.user}`;
      await expect(experienceOccurrencePrincipal(f.id)).rejects.toBeTruthy();
      const [row] =
        await db`select run_id from allrice_automation_runs where id=${f.id}`;
      expect(row!.run_id).toBeNull();
    },
  );
  it('oversized current rules fail the whole batch before a Run and retain the diagnostic', async () => {
    const f = await source();
    await db`insert into allrice_memories(organization_id,workspace_id,owner_id,employee_id,instance_id,content,visibility,source_type,lifecycle_state,memory_class,trust_level)
  values(${f.org},${f.workspace},${f.user},${f.e.employee_id ?? null},${f.e.instance_id},${'合成已确认记忆'.repeat(2000)},'private','user','durable','work_note','user_confirmed')`;
    const r = await f.reserve();
    if (!('automationRunId' in r)) throw Error('expected occurrence');
    await expect(
      dispatchExperienceOccurrence(r.automationRunId),
    ).rejects.toThrow('MEMORY_CURRENT_RULES_LIMIT');
    const [row] =
      await db`select status,error_code,run_id,experience_execution from allrice_automation_runs where id=${r.automationRunId}`;
    expect(row).toEqual({
      status: 'failed',
      error_code: 'MEMORY_CURRENT_RULES_LIMIT',
      run_id: null,
      experience_execution: null,
    });
  });
  it.each([
    { count: 17, text: '合成来源', selected: 16, bytes: 64 },
    { count: 9, text: '米'.repeat(4000), selected: 8, bytes: 32000 },
  ])(
    'keeps oldest complete sources bounded: $count inputs',
    async ({ count, text, selected, bytes }) => {
      const f = await source(text, count);
      const r = await f.reserve();
      if (!('automationRunId' in r)) throw Error('expected occurrence');
      const [row] =
        await db`select experience_occurrence from allrice_automation_runs where id=${r.automationRunId}`;
      const o = MemoryOccurrenceSchema.parse(row!.experience_occurrence);
      expect(o.sources).toHaveLength(selected);
      expect(o.sources.reduce((n, s) => n + s.excerpt.length, 0)).toBe(bytes);
      expect(o.sources.every((s) => s.excerpt === text)).toBe(true);
      const [pending] =
        await db`select count(*)::int total from allrice_experience_reviews where owner_id=${f.user} and consolidation_occurrence_id is null`;
      expect(pending!.total).toBe(count - selected);
      const [rule] =
        await db`select * from allrice_automations where id=${f.rule.id}`;
      await expect(
        db.begin((tx) =>
          reserveExperienceOccurrenceInTransaction(
            tx,
            rule as never,
            new Date(Date.now() + 86400000),
          ),
        ),
      ).resolves.toMatchObject({
        outcome: 'budget',
        budget: { instanceCount: 1 },
      });
    },
  );
  it('fails closed without waiting behind a concurrent policy writer', async () => {
    const f = await reserved();
    let release!: () => void, locked!: () => void;
    const ready = new Promise<void>((r) => {
      locked = r;
    });
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const writer = db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`experience-policy:${f.org}`},183))`;
      locked();
      await hold;
    });
    await ready;
    try {
      await expect(experienceOccurrencePrincipal(f.id)).rejects.toMatchObject({
        code: 'source_changed',
      });
    } finally {
      release();
      await writer;
    }
    expect((await experienceOccurrencePrincipal(f.id)).actor.id).toBe(f.user);
  });
  it.each(['success', 'invalid', 'withdraw', 'expired'] as const)(
    'settles a synthetic paid result atomically: %s',
    async (mode) => {
      const f = await reserved(),
        execution = await prepareExperienceExecution(f.id);
      await enqueueExperienceConsolidationRun(f.id);
      await enqueueExperienceConsolidationRun(f.id);
      const jobs =
        await db`select j.* from allrice_jobs j join allrice_automation_runs r on r.run_id=j.run_id where r.id=${f.id}`;
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!,
        workerId = randomUUID(),
        leaseToken = randomUUID();
      await db`update allrice_jobs set status='claimed',worker_id=${workerId},lease_token=${leaseToken},claimed_at=clock_timestamp(),heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '5 minutes' where id=${job.id}`;
      expect(await startClaimedJob(workerId, job.id, leaseToken)).toBeTruthy();
      const model = execution.model;
      const decision = await recordRouteDecision(
        RouteDecisionSchema.parse({
          schemaVersion: 1,
          id: randomUUID(),
          runId: job.run_id,
          organizationId: f.org,
          workspaceId: f.workspace,
          actorId: f.user,
          employeeId: f.occurrence.employeeId,
          inputChecksum: runtimePolicyDigest(execution),
          candidates: [],
          selectedKind: 'direct',
          selectedCandidateId: 'synthetic',
          harness: model.harness,
          provider: model.provider,
          model: model.model,
          modelConnectionId: model.connectionId,
          modelCatalogEntryId: model.modelCatalogEntryId,
          modelPolicyRevision: model.policyRevision,
          generation: 0,
          attempt: 1,
          reasonCodes: ['minimum_necessary_capability'],
          createdAt: new Date().toISOString(),
        }),
      );
      const subscription = resolveSubscriptionSnapshot({
        occurrenceId: f.id,
        modelSnapshot: model,
        decision,
        providerSnapshot: providerSnapshotForModelTarget(model),
      });
      if (subscription)
        await freezeRouteSubscriptionSnapshot({
          organizationId: f.org,
          workspaceId: f.workspace,
          decisionId: decision.id,
          snapshot: subscription,
        });
      await completeRouteDecision({
        organizationId: f.org,
        workspaceId: f.workspace,
        outcome: {
          decisionId: decision.id,
          status: 'succeeded',
          inputTokens: 30,
          cachedInputTokens: 10,
          outputTokens: 10,
          costCents: null,
          usageComplete: true,
          cacheUsageKnown: true,
          errorCode: null,
          completedAt: new Date().toISOString(),
        },
      });
      const skill = execution.nativeSkills[0]!,
        pin = execution.catalog.skills[0]!;
      await db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload)
      select ${f.org},${f.workspace},${job.run_id},coalesce(max(sequence),0)+1,'tool.completed',${db.json({ name: 'skill', nativePayload: { skillStatus: 'loaded', skillId: skill.id, skillChecksum: skill.checksum, skillVersion: pin.version, skillCatalogChecksum: execution.catalog.catalogChecksum }, internalTask: { occurrenceId: f.id } })} from allrice_run_events where run_id=${job.run_id}`;
      const output = {
        schemaVersion: 2,
        drafts: [
          {
            sourceIds: [f.e.memory_id],
            category: 'business_preference',
            content: '合成月报先列退款再汇总。',
            reason: '真人原文',
          },
        ],
        discarded: [],
        suggestions: [],
      };
      if (mode === 'invalid') output.drafts[0]!.sourceIds = [randomUUID()];
      if (mode === 'withdraw')
        await db`update allrice_memories set archived_at=clock_timestamp() where id=${f.e.memory_id}`;
      if (mode === 'expired')
        await db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${job.id}`;
      const complete = () =>
        completeJob({ workerId, jobId: job.id, leaseToken, result: output });
      if (mode === 'success') {
        await complete();
        await expect(complete()).rejects.toMatchObject({ code: 'lease_lost' });
      } else if (mode === 'invalid')
        await expect(complete()).rejects.toThrow(
          'MEMORY_DRAFT_SOURCE_MISMATCH',
        );
      else
        await expect(complete()).rejects.toMatchObject({
          code: mode === 'withdraw' ? 'source_changed' : 'lease_lost',
        });
      const [after] =
        await db`select r.experience_receipt,j.status from allrice_automation_runs r join allrice_jobs j on j.run_id=r.run_id where r.id=${f.id}`;
      if (mode === 'success') {
        expect(after!.experience_receipt).toMatchObject({
          schemaVersion: 2,
          output,
          outputDigest: runtimePolicyDigest(output),
        });
        expect(after!.status).toBe('succeeded');
        expect(after!.experience_receipt).not.toHaveProperty('state');
      } else expect(after!.experience_receipt).toBeNull();
      const ledger =
        await db`select input_tokens,output_tokens,cost_cents from allrice_model_usage_ledger where route_decision_id=${decision.id}`;
      expect(ledger).toEqual([
        { input_tokens: 30, output_tokens: 10, cost_cents: null },
      ]);
      expect(
        await db`select id from allrice_memories where owner_id=${f.user} and trust_level='user_confirmed'`,
      ).toHaveLength(0);
      expect(await listExperienceDrafts(f.owner)).toEqual([]);
    },
  );
});
