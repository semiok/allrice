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
  async function source(text = '合成品牌月报先列退款，再汇总净回款。') {
    const f = await createExperienceFixture(db, { authenticated: true });
    const session = await createChatSession(f.owner, {
      workspaceId: f.workspace,
      title: 'Synthetic M5-C source',
    });
    const sent = await sendChatMessage(f.owner, f.workspace, session.id, {
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
});
