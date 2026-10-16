import {
  syncExperienceAdoptions,
  readPrivateExperience,
  assertExperienceReadPins,
} from './experience-adoption.ts';
import {
  prepareRunExperiences,
  searchRunExperiences,
} from './experience-runtime.ts';
import { freezeEmployeeRuntimeContent } from './employees/employee-content.ts';
import {
  prepareEmployeeContentContext,
  assertEmployeeContentContext,
} from './employees/employee-runtime-content.ts';
import { createChatSession } from './workspace/service.ts';
import {
  syncExperienceValidations,
  experienceValidationStillCurrent,
} from './experience-validation.ts';
import {
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
} from './employees/platform-employees.ts';
import { attendanceAnswer } from './experience-validation.fixture.ts';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
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
  type PersonalSkillPin,
  resolveAssistantSubscriptionSnapshot,
} from '@allrice/contracts';
import type * as Client from './core/client.ts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import {
  createEmployeeInstance,
  prepareEmployeeInstanceSnapshot,
} from './employees/employee-instances.ts';
import { mutateEmployeeContent } from './employees/employee-content.ts';
import { collectPendingExperienceEvidence } from './experience-evidence.ts';
import { createExperienceStore } from './experience.ts';
import {
  syncExperienceConsolidationSchedules,
  prepareExperienceExecution,
  getExperienceExecution,
  listExperienceDrafts,
  updateExperiencePolicy,
  readExperiencePolicy,
} from './experience-consolidation.ts';
import {
  claimDueAutomations,
  syncAutomationRuns,
  listAutomations,
  runAutomationNow,
} from './execution/automation.ts';
import {
  enqueueRun,
  claimNextJob,
  startClaimedJob,
  completeJob,
  appendJobEvent,
  enqueueExperienceConsolidationRun,
} from './execution/queue.ts';
import { loadPlatformContentCatalog } from './platform-content/catalog.ts';
import { synchronizePlatformContent } from './platform-content/sync.ts';
import {
  deleteWorkspaceMemory,
  searchWorkspaceMemories,
} from './workspace/service.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  recordRouteDecision,
  completeRouteDecision,
} from './execution/route-decision.ts';
import { freezeRouteSubscriptionSnapshot } from './execution/route-subscription.ts';
import { providerSnapshotForModelTarget } from '../../../apps/worker/src/routing/provider-snapshot.ts';
let admin: ReturnType<typeof postgres>, db: ReturnType<typeof postgres>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `experience_consolidation_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
async function source(
  withSkill = false,
  materialize = true,
  attendance = false,
  published = false,
  feedback?: string,
) {
  const f = await createExperienceFixture(db, { published });
  for (const context of [f.owner, f.reviewer, f.neighbor])
    await db`insert into allrice_sessions(id,user_id,token_hash,expires_at)
    values(${context.sessionId},${context.actor.id},${(randomUUID() + randomUUID()).replaceAll('-', '')},clock_timestamp()+interval '1 day')`;
  const [old] =
    await db`select * from allrice_employee_runs where run_id=${f.run}`;
  const instance = await prepareEmployeeInstanceSnapshot(
    f.owner,
    f.session.id,
    old!.employee_assignment_id,
    old!.employee_version_id,
  );
  let pin: PersonalSkillPin | undefined;
  if (withSkill) {
    pin = {
      organizationId: f.org,
      ownerId: f.user,
      instanceId: instance.id,
      installationId: randomUUID(),
      versionId: randomUUID(),
      bindingId: randomUUID(),
      bindingEpoch: 1,
      definitionChecksum: 'sha256:' + 'a'.repeat(64),
    };
    await db.begin(async (tx) => {
      await tx`insert into allrice_personal_skill_installations(id,organization_id,owner_id,name,state,current_version_id) values(${pin!.installationId},${f.org},${f.user},'source-method','installed',${pin!.versionId})`;
      await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum) values(${pin!.versionId},${f.org},${f.user},${pin!.installationId},1,'{}','Synthetic source','{}',${pin!.definitionChecksum})`;
      await tx`insert into allrice_personal_skill_bindings(id,organization_id,workspace_id,owner_id,instance_id,installation_id,enabled,epoch) values(${pin!.bindingId},${f.org},${f.workspace},${f.user},${instance.id},${pin!.installationId},true,1)`;
    });
  }
  const runId = randomUUID(),
    messageId = randomUUID(),
    assistantId = randomUUID();
  const text =
    feedback ??
    (attendance
      ? '我已核对，到场和未到人数与原始名单一致，分项列出很清晰。'
      : '刚才的对账报告漏了退款，核对时需要单列退款再汇总净回款。');
  await db`insert into allrice_messages(id,organization_id,workspace_id,owner_id,session_id,role,content,status)
    values(${messageId},${f.org},${f.workspace},${f.user},${f.session.id},'user',${db.json({ text, citations: [] })},'completed'),
      (${assistantId},${f.org},${f.workspace},${f.user},${f.session.id},'assistant','{"text":"已收到"}','completed')`;
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${runId},${f.org},${f.workspace},${f.user},'succeeded','{}','{}')`;
  await db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,
    user_message_id,assistant_message_id,status,completed_at,provider_snapshot,prompt_snapshot,execution_snapshot,experience_capture_state)
    values(${runId},${f.org},${f.workspace},${f.user},${instance.assignmentId},${instance.source.employeeVersionId},${f.session.id},${messageId},${assistantId},
      'succeeded',clock_timestamp(),'{}','{}',${db.json({ instance, personalSkills: { skills: pin ? [pin] : [] } })},'pending')`;
  if (pin)
    await db`insert into allrice_run_events(organization_id,workspace_id,run_id,sequence,event_type,payload) values(${f.org},${f.workspace},${runId},1,'tool.completed',${db.json({ name: 'skill', nativePayload: { skillStatus: 'loaded', personalSkill: pin } })})`;
  await collectPendingExperienceEvidence({ database: db });
  const candidate = (await createExperienceStore().list(f.owner)).find(
    (c) => c.source?.runId === runId,
  )!;
  expect(candidate?.originKind).toBe('incremental');
  if (materialize) await syncExperienceConsolidationSchedules();
  const [rule] =
    await db`select * from allrice_automations where owner_id=${f.user} and experience_binding is not null`;
  if (materialize) expect(rule).toBeTruthy();
  return { ...f, instance, candidate, rule: rule!, sourceRunId: runId, pin };
}
async function currentRequirement(f: Awaited<ReturnType<typeof source>>) {
  const contentId = randomUUID();
  const base = {
    workspaceId: f.workspace,
    setId: randomUUID(),
    ownership: {
      scope: 'personal' as const,
      organizationId: f.org,
      ownerId: f.user,
    },
    target: { kind: 'instance' as const, instanceId: f.instance.id },
    changeSummary: 'QA current rules',
  };
  const saved = await mutateEmployeeContent(f.owner, {
    ...base,
    requestId: randomUUID(),
    expectedRevision: 0,
    operation: 'save_draft',
    textEdits: [
      {
        contentId,
        revisionId: randomUUID(),
        expectedRevision: 0,
        kind: 'requirement',
        title: '退款口径',
        body: '以实际退款逐条扣减，不以预算代替实际发生。',
      },
    ],
    manifest: {
      schemaVersion: 1,
      common: [{ sourceKind: 'draft_text', contentId }],
      scenes: [],
      declaredConflicts: [],
    },
  });
  const checked = await mutateEmployeeContent(f.owner, {
    ...base,
    requestId: randomUUID(),
    expectedRevision: saved.revision,
    operation: 'validate',
    candidateRevisionId: saved.candidate.id,
    candidateDigest: saved.candidate.digest,
  });
  expect(checked.validation?.valid).toBe(true);
  await mutateEmployeeContent(f.owner, {
    ...base,
    requestId: randomUUID(),
    expectedRevision: checked.revision,
    operation: 'activate',
    candidateRevisionId: checked.candidate.id,
    candidateDigest: checked.candidate.digest,
  });
  return { contentId, setId: base.setId };
}
async function queued(
  withSkill = false,
  withRule = false,
  attendance = false,
  published = false,
  feedback?: string,
) {
  const f = await source(withSkill, true, attendance, published, feedback);
  const current = withRule ? await currentRequirement(f) : null;
  await db`update allrice_automations set next_run_at=clock_timestamp()-interval '1 second' where id=${f.rule.id}`;
  await Promise.all([claimDueAutomations(), claimDueAutomations()]);
  const [occurrence] =
    await db`select * from allrice_automation_runs where automation_id=${f.rule.id}`;
  expect(occurrence?.run_id).toBeTruthy();
  return { ...f, current, occurrence: occurrence! };
}
async function leased(
  withSkill = false,
  withRule = false,
  attendance = false,
  published = false,
  feedback?: string,
) {
  const f = await queued(withSkill, withRule, attendance, published, feedback),
    workerId = randomUUID();
  const job = await claimNextJob(workerId, 120000, { allowBackground: true });
  expect(
    (await db`select run_id from allrice_jobs where id=${job!.id}`)[0]!.run_id,
  ).toBe(f.occurrence.run_id);
  const lease = { workerId, jobId: job!.id, leaseToken: job!.lease!.token };
  expect(
    await startClaimedJob(workerId, job!.id, job!.lease!.token),
  ).toBeTruthy();
  return {
    ...f,
    job: job!,
    lease,
    frozen: await getExperienceExecution(f.occurrence.run_id),
  };
}
async function proof(f: Awaited<ReturnType<typeof leased>>, load = true) {
  const { execution, occurrence } = f.frozen,
    model = execution.model,
    skill = execution.nativeSkills[0]!;
  const decision = await recordRouteDecision(
    RouteDecisionSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      runId: f.occurrence.run_id,
      organizationId: f.org,
      workspaceId: f.workspace,
      actorId: f.user,
      employeeId: occurrence.employeeId,
      inputChecksum: runtimePolicyDigest(execution),
      candidates: [],
      selectedKind: 'agent_skill',
      selectedCandidateId: skill.id,
      harness: 'dsh',
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
  const snapshot = resolveAssistantSubscriptionSnapshot({
    occurrenceId: occurrence.id,
    modelSnapshot: model,
    decision,
    providerSnapshot: providerSnapshotForModelTarget(model),
  })!;
  await freezeRouteSubscriptionSnapshot({
    organizationId: f.org,
    workspaceId: f.workspace,
    decisionId: decision.id,
    snapshot,
  });
  await completeRouteDecision({
    organizationId: f.org,
    workspaceId: f.workspace,
    outcome: {
      decisionId: decision.id,
      status: 'succeeded',
      inputTokens: 30,
      cachedInputTokens: 0,
      outputTokens: 10,
      costCents: null,
      usageComplete: true,
      cacheUsageKnown: true,
      errorCode: null,
      completedAt: new Date().toISOString(),
    },
  });
  if (load)
    await appendJobEvent({
      ...f.lease,
      type: 'tool.completed',
      payload: {
        name: 'skill',
        internalTask: {
          kind: 'experience_consolidation',
          occurrenceId: occurrence.id,
        },
        nativePayload: {
          skillStatus: 'loaded',
          skillId: skill.id,
          skillChecksum: skill.checksum,
          skillVersion: execution.catalog.skills[0]!.version,
          skillCatalogChecksum: execution.catalog.catalogChecksum,
        },
      },
    });
  return {
    schemaVersion: 1,
    drafts: [
      {
        sourceIds: [f.candidate.id],
        rule: '对账时单列退款，再汇总净回款。',
        reason: '用户指出漏算退款',
        applicability: '含退款的回款对账',
        confidence: 'tentative',
        validation: {
          kind: 'calculation',
          check: '含退款的样本独立复算净回款。',
        },
      },
    ],
    discarded: [],
  };
}
suite(
  'MET183 private consolidation — real isolated PostgreSQL, no paid model',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      assertRuntimeFixtureDatabase(url);
      admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
      await admin.unsafe(`create schema ${schema}`);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      db = postgres(url.toString(), { max: 8, onnotice: () => {} });
      const dir = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(dir))
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(file, dir), 'utf8'));
      vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
      await synchronizePlatformContent(await loadPlatformContentCatalog());
    }, 120000);
    beforeEach(async () => {
      await db`update allrice_automations set status='paused',next_run_at=null`;
      await db`update allrice_settings set value=jsonb_set(value,'{validationMode}','\"off\"') where value->>'schemaVersion' in ('3','4')`;
      await db`update allrice_platform_employee_test_runs set status='failed',completed_at=clock_timestamp() where purpose='experience_validation' and status in ('queued','running')`;
      await db`update allrice_settings set value=jsonb_set(value,'{adoptionMode}','"off"') where value->>'schemaVersion'='4'`;
      await db`update allrice_jobs set status='canceled',completed_at=clock_timestamp() where status in ('queued','claimed','running')`;
    });
    afterAll(async () => {
      vi.unstubAllEnvs();
      await db?.end({ timeout: 5 });
      if (admin && /^experience_consolidation_[a-f0-9]{32}$/.test(schema))
        await admin.unsafe(`drop schema ${schema} cascade`);
      await admin?.end({ timeout: 5 });
    });
    async function validationFixture(attendance = true, enable = true) {
      const f = await leased(false, false, attendance, true),
        output = await proof(f);
      if (attendance)
        Object.assign(output.drafts[0]!, {
          rule: '统计到场情况时，依据原始名单分别核对到场和未到人数，并在结果中分项列出。',
          applicability:
            '适用于有原始名单且到场状态明确的人员统计任务，不适用于缺少名单或状态不明时推算人数。',
        });
      await completeJob({ ...f.lease, result: output });
      await syncAutomationRuns();
      if (enable)
        await updateExperiencePolicy(f.reviewer, f.org, {
          expectedRevision: (await readExperiencePolicy(f.org)).revision,
          frequency: 'daily',
          timezone: 'Asia/Shanghai',
          time: '03:00',
          weekday: 1,
          monthDay: 1,
          validationMode: 'supported_cases',
        });
      return { ...f, output };
    }
    async function validationReceipt(
      test: NonNullable<
        Awaited<ReturnType<typeof claimNextPlatformEmployeeTestRun>>
      >,
      answer: unknown,
    ) {
      const x = test.experienceCandidate!;
      const snapshot = resolveAssistantSubscriptionSnapshot({
        occurrenceId: x.occurrenceId,
        modelSnapshot: x.modelSnapshot,
        decision: x.decision,
        providerSnapshot: providerSnapshotForModelTarget(x.modelSnapshot),
      })!;
      await freezeRouteSubscriptionSnapshot({
        organizationId: test.previewContext.organizationId,
        workspaceId: test.previewContext.workspaceId,
        decisionId: x.decision.id,
        snapshot,
      });
      return {
        answer: JSON.stringify(answer),
        provider: x.modelSnapshot.provider,
        model: x.modelSnapshot.model,
        threadId: null,
        usage: { inputTokens: 100, outputTokens: 120, cachedInputTokens: 0 },
        events: [],
        error: null,
        modelExecution: {
          dispatched: true,
          subscriptionSnapshotCreated: true,
          usageComplete: true,
          cacheUsageKnown: false,
          costCents: null,
        },
      };
    }
    it('validates the same draft once with a private test and independently persists coverage without adoption', async () => {
      const f = await validationFixture();
      await Promise.all([
        syncExperienceValidations(),
        syncExperienceValidations(),
      ]);
      const tests =
        await db`select * from allrice_platform_employee_test_runs where experience_binding->>'occurrenceId'=${f.occurrence.id}`;
      expect(
        tests,
        JSON.stringify(
          await db`select status, experience_validation_plan, (experience_receipt is not null) receipt from allrice_automation_runs where id=${f.occurrence.id}`,
        ),
      ).toHaveLength(1);
      expect(tests[0]!.input.prompt).toContain('complete-a');
      const test = (await claimNextPlatformEmployeeTestRun(randomUUID()))!;
      expect(test.experienceCandidate?.instructions).toContain(
        f.output.drafts[0]!.rule,
      );
      expect(test.previewContext.ownerId).toBe(f.user);
      expect(
        test.previewExecution.policySnapshot.grants.map((g) => g.action),
      ).toEqual(['job:execute']);
      await completePlatformEmployeeTestRun(
        test.id,
        await validationReceipt(test, attendanceAnswer),
      );
      const batches = await listExperienceDrafts(f.owner);
      expect(batches[0]!.validations[0]).toMatchObject({
        validationStatus: 'passed',
        active: false,
        outputDigest: runtimePolicyDigest(f.output),
        assertion: { passed: true },
      });
      expect(await listExperienceDrafts(f.neighbor)).toEqual([]);
      expect(await listExperienceDrafts(f.reviewer)).toEqual([]);
      expect(
        await searchWorkspaceMemories(f.owner, {
          workspaceId: f.workspace,
          query: '到场',
        }),
      ).toEqual([]);
      await syncExperienceValidations();
      expect(
        await db`select id from allrice_platform_employee_test_runs where experience_binding->>'occurrenceId'=${f.occurrence.id}`,
      ).toHaveLength(1);
      const ledger =
        await db`select l.cost_cents,l.output_tokens from allrice_model_usage_ledger l where l.route_decision_id=${test.experienceCandidate!.decision.id}`;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.cost_cents).toBeNull();
      expect(Number(ledger[0]!.output_tokens)).toBe(120);
      await expect(
        db`update allrice_platform_employee_test_runs set experience_binding=jsonb_set(experience_binding,'{ownerId}',to_jsonb(${f.neighbor.actor.id}::text)) where id=${test.id}`,
      ).rejects.toThrow('immutable');
      await expect(
        db`update allrice_automation_runs set experience_validation_plan=null where id=${f.occurrence.id}`,
      ).rejects.toThrow('immutable');
    });
    async function adoptedFixture() {
      const f = await validationFixture();
      await syncExperienceValidations();
      const test = (await claimNextPlatformEmployeeTestRun(randomUUID()))!;
      await completePlatformEmployeeTestRun(
        test.id,
        await validationReceipt(test, attendanceAnswer),
      );
      await updateExperiencePolicy(f.reviewer, f.org, {
        expectedRevision: (await readExperiencePolicy(f.org)).revision,
        frequency: 'daily',
        timezone: 'Asia/Shanghai',
        time: '03:00',
        weekday: 1,
        monthDay: 1,
        adoptionMode: 'supported_private',
      });
      await Promise.all([syncExperienceAdoptions(), syncExperienceAdoptions()]);
      const rows =
        await db`select m.*,e.adoption_proof,e.reviewed_by from allrice_memories m join allrice_experience_reviews e on e.memory_id=m.id
        where e.owner_id=${f.user} and e.origin_kind='derived'`;
      expect(
        rows,
        JSON.stringify(
          await db`select experience_adoption_plan from allrice_automation_runs where id=${f.occurrence.id}`,
        ),
      ).toHaveLength(1);
      return { ...f, memory: rows[0]!, validationId: test.id };
    }
    async function experienceRun(
      f: Awaited<ReturnType<typeof adoptedFixture>>,
      text: string,
      sessionId?: string,
    ) {
      const session = sessionId
        ? { id: sessionId }
        : await createChatSession(f.owner, {
            workspaceId: f.workspace,
            employeeAssignmentId: f.instance.assignmentId,
            employeeInstanceId: f.instance.id,
            title: 'Synthetic experience use',
          });
      const content = await freezeEmployeeRuntimeContent(f.owner, {
        instanceId: f.instance.id,
        employeeId: f.frozen.occurrence.employeeId,
        employeeVersionId: f.instance.source.employeeVersionId,
      });
      const runId = randomUUID(),
        userMessage = randomUUID(),
        assistant = randomUUID();
      await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,status)
        values(${userMessage},${f.org},${f.workspace},${session.id},${f.user},'user',${db.json({ text, citations: [] })},'completed'),
        (${assistant},${f.org},${f.workspace},${session.id},${f.user},'assistant','{"text":"","citations":[]}','pending')`;
      await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
        values(${runId},${f.org},${f.workspace},${f.user},'running','{}','{}')`;
      await db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,session_id,employee_assignment_id,employee_version_id,
        user_message_id,assistant_message_id,status,provider_snapshot,prompt_snapshot,execution_snapshot)
        values(${runId},${f.org},${f.workspace},${f.user},${session.id},${f.instance.assignmentId},${f.instance.source.employeeVersionId},
        ${userMessage},${assistant},'running','{}',${db.json({ userRequest: text, memories: [], conversation: [], systemPrompt: 'Synthetic' })},
        ${db.json({ instance: f.instance, content })})`;
      const worker = {
        jobId: randomUUID(),
        workerId: randomUUID(),
        leaseToken: randomUUID(),
        attempt: 1,
      };
      await db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at,attempt)
        values(${worker.jobId},${f.org},${f.workspace},${f.user},${runId},'running',${randomUUID()},clock_timestamp()+interval '5 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${worker.workerId},${worker.leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes',1)`;
      return {
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        sessionId: session.id,
        runId,
        worker,
      };
    }
    it('adopts the existing independent proof once, without forging human review or rerunning validation', async () => {
      const f = await adoptedFixture();
      expect(f.memory.reviewed_by).toBeNull();
      expect(
        (await createExperienceStore().list(f.owner)).some(
          (m) => m.id === f.memory.id,
        ),
      ).toBe(false);
      expect(
        (await listExperienceDrafts(f.owner))[0]!.adoptions[0]?.memoryId,
      ).toBe(f.memory.id);
      expect(f.memory.adoption_proof.validation.testId).toBe(f.validationId);
      expect(f.memory.visibility).toBe('private');
      expect(f.memory.instance_id).toBe(f.instance.id);
      expect(
        await db`select id from allrice_memory_revisions where memory_id=${f.memory.id}`,
      ).toHaveLength(1);
      expect(
        await db`select id from allrice_rag_chunks where memory_id=${f.memory.id}`,
      ).toHaveLength(1);
      await syncExperienceValidations();
      await syncExperienceAdoptions();
      expect(
        await db`select id from allrice_platform_employee_test_runs where experience_binding->>'occurrenceId'=${f.occurrence.id}`,
      ).toHaveLength(1);
      await expect(
        db.begin((tx) => readPrivateExperience(tx, f.neighbor, f.memory.id)),
      ).rejects.toThrow('source_changed');
      expect(
        await searchWorkspaceMemories(f.owner, {
          workspaceId: f.workspace,
          query: '到场',
        }),
      ).toEqual([]);
      await expect(
        createExperienceStore().review(f.owner, f.memory.id, {
          decision: 'approve',
          expectedRevision: 1,
          expectedDigest: f.memory.adoption_proof.contentDigest,
          reason: 'bypass',
        }),
      ).rejects.toThrow();
    });
    it('uses the exact private instance in a new Session and forgets before rotating native history; retries cannot revive it', async () => {
      const f = await adoptedFixture();
      const scope = await experienceRun(
        f,
        '请根据这份名单核对到场和未到人数，分别列出成员。名单：陈一=到场；李二=未到；王三=到场。',
      );
      const first = await prepareRunExperiences(scope, scope.worker);
      expect(first.memories.map((m) => m.id)).toEqual([f.memory.id]);
      const runtime = (await prepareEmployeeContentContext(scope))!;
      expect(runtime.nativeContextKey).toContain(scope.runId);
      expect((await searchRunExperiences(scope)).map((m) => m.id)).toEqual([
        f.memory.id,
      ]);
      await prepareRunExperiences(scope, scope.worker);
      expect(
        (
          await db`select recall_count from allrice_memories where id=${f.memory.id}`
        )[0]!.recall_count,
      ).toBe(1);
      const unrelated = await experienceRun(f, '请写一段旅行建议。');
      expect(
        (await prepareRunExperiences(unrelated, unrelated.worker)).memories,
      ).toEqual([]);
      const forget = await experienceRun(
        f,
        '请忘记你整理的“到场和未到人数分项列出”这条个人经验，以后不要自动采用。',
        scope.sessionId,
      );
      const forgotten = await prepareRunExperiences(forget, forget.worker);
      expect(forgotten.receipt).toMatchObject({
        status: 'forgotten',
        memoryId: f.memory.id,
      });
      expect(forgotten.memories).toEqual([]);
      const nextContext = (await prepareEmployeeContentContext(forget))!;
      expect(nextContext.generationId).not.toBe(runtime.generationId);
      expect(nextContext.allowedMessageIds).not.toBeNull();
      await expect(
        assertEmployeeContentContext(scope, runtime.generationId),
      ).rejects.toThrow();
      await expect(searchRunExperiences(scope)).rejects.toThrow();
      expect(
        (await prepareRunExperiences(forget, forget.worker)).receipt,
      ).toEqual(forgotten.receipt);
      const next = await experienceRun(
        f,
        '请核对到场和未到人数，名单：一=到场。',
      );
      expect((await prepareRunExperiences(next, next.worker)).memories).toEqual(
        [],
      );
      await syncExperienceAdoptions();
      expect(
        await db`select memory_id from allrice_experience_reviews where owner_id=${f.user} and origin_kind='derived'`,
      ).toHaveLength(1);
      expect(
        await db`select id from allrice_memory_revisions where memory_id=${f.memory.id}`,
      ).toHaveLength(2);
      expect(
        await db`select id from allrice_rag_chunks where memory_id=${f.memory.id}`,
      ).toHaveLength(0);
      expect(
        (await listExperienceDrafts(f.owner))[0]!.adoptions[0]?.state,
      ).toBe('forgotten');
    });
    it('fails closed on changed evidence and does not let another principal search or prepare a bound Run', async () => {
      const f = await adoptedFixture();
      const scope = await experienceRun(f, '请核对名单中到场和未到的人数。');
      const prepared = await prepareRunExperiences(scope, scope.worker);
      expect(prepared.memories).toHaveLength(1);
      await expect(
        prepareRunExperiences(
          { ...scope, ownerId: f.neighbor.actor.id },
          scope.worker,
        ),
      ).rejects.toThrow();
      expect(
        await searchRunExperiences({ ...scope, ownerId: f.neighbor.actor.id }),
      ).toEqual([]);
      await deleteWorkspaceMemory(f.owner, f.workspace, f.candidate.id);
      const [bound] =
        await db`select experience_reads from allrice_employee_runs where run_id=${scope.runId}`;
      await expect(
        db.begin((tx) =>
          assertExperienceReadPins(f.owner, bound!.experience_reads, tx),
        ),
      ).rejects.toThrow();
      const next = await experienceRun(f, '请核对名单中到场和未到的人数。');
      expect((await prepareRunExperiences(next, next.worker)).memories).toEqual(
        [],
      );
    });
    it('does not leak adopted experience into another instance owned by the same person', async () => {
      const f = await adoptedFixture();
      const other = await createEmployeeInstance(f.owner, {
        workspaceId: f.workspace,
        assignmentId: f.instance.assignmentId,
        requestId: randomUUID(),
        profile: { name: 'Independent private employee' },
      });
      const scope = await experienceRun(
        { ...f, instance: other },
        '请根据原始名单核对到场和未到人数。',
      );
      expect(
        (await prepareRunExperiences(scope, scope.worker)).memories,
      ).toEqual([]);
      expect(await searchRunExperiences(scope)).toEqual([]);
      expect(
        (
          await db`select recall_count from allrice_memories where id=${f.memory.id}`
        )[0]!.recall_count,
      ).toBe(0);
    });
    it('does not rescan a waiting draft because a different draft already has a terminal proof', async () => {
      const f = await adoptedFixture();
      // A persisted partial plan waits for draft 1. Its draft-0 proof is already terminal.
      const waiting = {
        status: 'awaiting_validation',
        pendingDrafts: [1],
        drafts: [{ draftIndex: 0, memoryId: f.memory.id }],
      };
      await db`update allrice_automation_runs set experience_adoption_plan=${db.json(waiting)} where id=${f.occurrence.id}`;
      await syncExperienceAdoptions();
      expect(
        (
          await db`select experience_adoption_plan from allrice_automation_runs where id=${f.occurrence.id}`
        )[0]!.experience_adoption_plan,
      ).toEqual(waiting);
    });
    it('adopts after a delayed proof without treating the first missing result as final or rerunning validation', async () => {
      const f = await validationFixture(true, false);
      const settings = {
        frequency: 'daily',
        timezone: 'Asia/Shanghai',
        time: '03:00',
        weekday: 1,
        monthDay: 1,
        adoptionMode: 'supported_private',
      };
      await updateExperiencePolicy(f.reviewer, f.org, {
        ...settings,
        expectedRevision: (await readExperiencePolicy(f.org)).revision,
      });
      await syncExperienceAdoptions();
      expect(
        (
          await db`select experience_adoption_plan from allrice_automation_runs where id=${f.occurrence.id}`
        )[0]!.experience_adoption_plan.status,
      ).toBe('awaiting_validation');
      await updateExperiencePolicy(f.reviewer, f.org, {
        ...settings,
        validationMode: 'supported_cases',
        expectedRevision: (await readExperiencePolicy(f.org)).revision,
      });
      await syncExperienceValidations();
      const test = (await claimNextPlatformEmployeeTestRun(randomUUID()))!;
      await syncExperienceAdoptions();
      expect(
        await db`select memory_id from allrice_experience_reviews where owner_id=${f.user} and origin_kind='derived'`,
      ).toHaveLength(0);
      await completePlatformEmployeeTestRun(
        test.id,
        await validationReceipt(test, attendanceAnswer),
      );
      await syncExperienceAdoptions();
      expect(
        await db`select memory_id from allrice_experience_reviews where owner_id=${f.user} and origin_kind='derived'`,
      ).toHaveLength(1);
      await syncExperienceAdoptions();
      expect(
        await db`select id from allrice_platform_employee_test_runs where experience_binding->>'occurrenceId'=${f.occurrence.id}`,
      ).toHaveLength(1);
    });
    it.each([true, false])(
      'uses direct report preference proof without a model test; specific=%s',
      async (specific) => {
        const f = await leased(
          false,
          false,
          false,
          true,
          specific
            ? '反馈：这份报告分点说明很清晰，阅读起来很方便。'
            : '反馈：很好，很清晰。',
        );
        const output = await proof(f);
        Object.assign(output.drafts[0]!, {
          rule: '撰写报告时采用分点说明。',
          applicability:
            '仅适用于报告的表达方式，不改变业务规则、计算口径或执行步骤。',
          validation: { kind: 'preference', check: '仅报告表达方式' },
        });
        await completeJob({ ...f.lease, result: output });
        await syncAutomationRuns();
        await updateExperiencePolicy(f.reviewer, f.org, {
          expectedRevision: (await readExperiencePolicy(f.org)).revision,
          frequency: 'daily',
          timezone: 'Asia/Shanghai',
          time: '03:00',
          weekday: 1,
          monthDay: 1,
          adoptionMode: 'supported_private',
        });
        await syncExperienceAdoptions();
        const rows =
          await db`select adoption_proof from allrice_experience_reviews where owner_id=${f.user} and origin_kind='derived'`;
        expect(rows).toHaveLength(specific ? 1 : 0);
        if (specific)
          expect(rows[0]!.adoption_proof.validation).toMatchObject({
            kind: 'direct_preference',
            evaluator: 'report-style-v1',
          });
        expect(
          await db`select id from allrice_platform_employee_test_runs where experience_binding->>'occurrenceId'=${f.occurrence.id}`,
        ).toHaveLength(0);
      },
    );
    it.each(['canceled', 'expired', 'replaced'] as const)(
      'does not apply a forget command from a %s worker',
      async (mode) => {
        const f = await adoptedFixture();
        const scope = await experienceRun(
          f,
          '请忘记你整理的“到场和未到人数分项列出”这条个人经验，以后不要自动采用。',
        );
        if (mode === 'canceled')
          await db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${scope.worker.jobId}`;
        if (mode === 'expired')
          await db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${scope.worker.jobId}`;
        if (mode === 'replaced')
          await db`update allrice_jobs set lease_token=${randomUUID()},attempt=2 where id=${scope.worker.jobId}`;
        await expect(
          prepareRunExperiences(scope, scope.worker),
        ).rejects.toThrow('identity_denied');
        expect(
          (
            await db`select archived_at from allrice_memories where id=${f.memory.id}`
          )[0]!.archived_at,
        ).toBeNull();
        expect(
          (
            await db`select experience_action_receipt from allrice_employee_runs where run_id=${scope.runId}`
          )[0]!.experience_action_receipt,
        ).toBeNull();
      },
    );
    it.each(['canceled', 'lease-expired', 'terminal'] as const)(
      'stops the exact validation worker after %s and rejects another lease',
      async (kind) => {
        await validationFixture();
        await syncExperienceValidations();
        const workerId = randomUUID(),
          test = (await claimNextPlatformEmployeeTestRun(workerId))!;
        const execution = {
          runId: test.previewExecution.runId,
          jobId: test.previewExecution.jobId,
          leaseToken: test.previewExecution.leaseToken,
          workerId,
        };
        expect(await experienceValidationStillCurrent(test.id, execution)).toBe(
          true,
        );
        expect(
          await experienceValidationStillCurrent(test.id, {
            ...execution,
            leaseToken: randomUUID(),
          }),
        ).toBe(false);
        if (kind === 'canceled')
          await db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${execution.jobId}`;
        if (kind === 'lease-expired')
          await db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${execution.jobId}`;
        if (kind === 'terminal')
          await completePlatformEmployeeTestRun(
            test.id,
            await validationReceipt(test, attendanceAnswer),
          );
        expect(await experienceValidationStillCurrent(test.id, execution)).toBe(
          false,
        );
      },
    );
    it('takes the final user admission lock before waiting behind a content writer', async () => {
      const f = await validationFixture();
      await syncExperienceValidations();
      let release!: () => void, ready!: (pid: number) => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const acquired = new Promise<number>((r) => {
        ready = r;
      });
      const blocker = db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${f.org}`},0))`;
        ready((await tx`select pg_backend_pid() pid`)[0]!.pid);
        await gate;
      });
      const gatePid = await acquired;
      const claim = claimNextPlatformEmployeeTestRun(randomUUID());
      let writerPid = 0,
        writer: Promise<unknown> | undefined;
      try {
        await expect
          .poll(
            async () =>
              Number(
                (
                  await db`select count(*) n from pg_stat_activity where ${gatePid}=any(pg_blocking_pids(pid))`
                )[0]!.n,
              ),
            { timeout: 3000 },
          )
          .toBeGreaterThan(0);
        const [claimProcess] =
          await db`select pid from pg_stat_activity where ${gatePid}=any(pg_blocking_pids(pid)) and query like '%pg_advisory_xact_lock_shared%'`;
        expect(claimProcess).toBeTruthy();
        let writerReady!: () => void;
        const started = new Promise<void>((r) => {
          writerReady = r;
        });
        writer = db.begin(async (tx) => {
          writerPid = (await tx`select pg_backend_pid() pid`)[0]!.pid;
          writerReady();
          await tx`select id from allrice_users where id=${f.user} for share`;
          await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${f.org}`},0))`;
        });
        await started;
        await expect
          .poll(
            async () =>
              (
                await db`select ${claimProcess!.pid}=any(pg_blocking_pids(${writerPid})) blocked`
              )[0]!.blocked,
            { timeout: 3000 },
          )
          .toBe(true);
      } finally {
        release();
        await blocker;
        await Promise.all([claim, writer]);
      }
    });
    it('does not charge under old/off policy and records unsupported drafts without testing', async () => {
      const old = await validationFixture(true, false);
      await syncExperienceValidations();
      expect(
        await db`select id from allrice_platform_employee_test_runs where experience_binding->>'occurrenceId'=${old.occurrence.id}`,
      ).toHaveLength(0);
      const unsupported = await validationFixture(false);
      await syncExperienceValidations();
      const view = (await listExperienceDrafts(unsupported.owner))[0]!;
      expect(view.validations).toEqual([]);
      expect(view.validationNotes[0]).toContain('暂无覆盖');
    });
    it.each([
      'wrong-count',
      'revoked',
      'disabled',
      'timeout',
      'deadline',
    ] as const)(
      'preserves %s validation failure without approving or re-running',
      async (kind) => {
        const f = await validationFixture();
        await syncExperienceValidations();
        const test = (await claimNextPlatformEmployeeTestRun(randomUUID()))!;
        const answer = structuredClone(attendanceAnswer);
        if (kind === 'wrong-count') answer.results[0]!.present!.count = 12;
        const receipt = await validationReceipt(test, answer);
        if (kind === 'revoked')
          await db`update allrice_memberships set active=false where user_id=${f.user}`;
        if (kind === 'disabled')
          await updateExperiencePolicy(f.reviewer, f.org, {
            expectedRevision: (await readExperiencePolicy(f.org)).revision,
            frequency: 'daily',
            timezone: 'Asia/Shanghai',
            time: '03:00',
            weekday: 1,
            monthDay: 1,
            validationMode: 'off',
          });
        if (kind === 'deadline')
          await db`update allrice_platform_employee_test_runs set started_at=clock_timestamp()-interval '6 minutes' where id=${test.id}`;
        if (kind === 'timeout')
          await db`update allrice_platform_employee_test_runs set timeout_at=clock_timestamp()-interval '1 second' where id=${test.id}`;
        await completePlatformEmployeeTestRun(test.id, receipt);
        const [row] =
          await db`select experience_assertion from allrice_platform_employee_test_runs where id=${test.id}`;
        expect(row!.experience_assertion.passed).toBe(false);
        expect(row!.experience_assertion.reason).toBe(
          kind === 'wrong-count'
            ? 'count_or_membership_mismatch'
            : kind === 'timeout' || kind === 'deadline'
              ? 'execution_failed'
              : 'authority_changed',
        );
        expect(
          await db`select id from allrice_model_usage_ledger where route_decision_id=${test.experienceCandidate!.decision.id}`,
        ).toHaveLength(1);
        await syncExperienceValidations();
        expect(
          await db`select id from allrice_platform_employee_test_runs where experience_binding->>'occurrenceId'=${f.occurrence.id}`,
        ).toHaveLength(1);
      },
    );
    it('uses two producers without duplicate occurrence/jobs and rejects the browser lane', async () => {
      const f = await queued();
      const rows =
        await db`select id from allrice_jobs where run_id=${f.occurrence.run_id}`;
      expect(rows).toHaveLength(1);
      await enqueueExperienceConsolidationRun(f.occurrence.id);
      expect(
        await db`select id from allrice_jobs where run_id=${f.occurrence.run_id}`,
      ).toHaveLength(1);
      await expect(
        enqueueRun(f.owner, {
          workspaceId: f.workspace,
          type: 'allrice.experience.consolidate',
          input: { occurrenceId: f.occurrence.id },
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      expect(
        (await listAutomations(f.owner, f.workspace)).automations.some(
          (a) => a.id === f.rule.id,
        ),
      ).toBe(false);
      await expect(
        runAutomationNow(f.owner, f.workspace, f.rule.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        await db`select id from allrice_chat_sessions where owner_id=${f.user}`,
      ).toHaveLength(1);
    });
    it('reserves foreground capacity and only one background slot across workers', async () => {
      const a = await queued(),
        b = await queued();
      expect(await claimNextJob(randomUUID(), 120000)).toBeNull();
      const jobs = await Promise.all([
        claimNextJob(randomUUID(), 120000, { allowBackground: true }),
        claimNextJob(randomUUID(), 120000, { allowBackground: true }),
      ]);
      expect(jobs.filter(Boolean)).toHaveLength(1);
      expect([a.occurrence.run_id, b.occurrence.run_id]).toContain(
        (
          await db`select run_id from allrice_jobs where id=${jobs.find(Boolean)!.id}`
        )[0]!.run_id,
      );
    });
    it('freezes actual effective rules and refuses output after those rules change', async () => {
      const f = await source();
      const current = await currentRequirement(f);
      await db`update allrice_automations set next_run_at=clock_timestamp()-interval '1 second' where id=${f.rule.id}`;
      await claimDueAutomations();
      const [batch] =
        await db`select run_id from allrice_automation_runs where automation_id=${f.rule.id}`;
      const frozen = await getExperienceExecution(batch!.run_id);
      expect(frozen.occurrence.currentRules.sources[0]?.body).toBe(
        '以实际退款逐条扣减，不以预算代替实际发生。',
      );
      // Simulate source retirement under the same authority mutex used by production.
      await db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${f.org}`},0))`;
        await tx`update allrice_employee_content_sets set active_revision_id=null where id=${current.setId}`;
      });
      await expect(getExperienceExecution(batch!.run_id)).rejects.toMatchObject(
        { code: 'source_changed' },
      );
    });
    it('persists only a draft after real route proof and native load, retaining immutable feedback', async () => {
      const f = await leased(),
        output = await proof(f);
      const before =
        await db`select source_excerpt,source_digest,evidence from allrice_experience_reviews where memory_id=${f.candidate.id}`;
      await completeJob({ ...f.lease, result: output });
      expect((await listExperienceDrafts(f.owner))[0]).toMatchObject({
        state: 'pending_validation',
        revision: 1,
        digest: runtimePolicyDigest(output),
        drafts: output.drafts,
      });
      expect(await listExperienceDrafts(f.neighbor)).toEqual([]);
      expect(
        await db`select source_excerpt,source_digest,evidence from allrice_experience_reviews where memory_id=${f.candidate.id}`,
      ).toEqual(before);
      expect(
        await searchWorkspaceMemories(f.owner, {
          workspaceId: f.workspace,
          query: '退款',
        }),
      ).toEqual([]);
      await expect(
        db`update allrice_experience_reviews set consolidation_occurrence_id=null where memory_id=${f.candidate.id}`,
      ).rejects.toThrow('immutable');
      await expect(
        db`update allrice_experience_reviews set source_excerpt='changed' where memory_id=${f.candidate.id}`,
      ).rejects.toThrow('origin and completed reviews are immutable');
      await expect(
        db`update allrice_experience_reviews set consolidated_at=null where memory_id=${f.candidate.id}`,
      ).rejects.toThrow('consolidation progress is immutable');
      await expect(
        db`update allrice_automation_runs set experience_receipt='{}' where id=${f.occurrence.id}`,
      ).rejects.toThrow('occurrence is immutable');
    });
    it('holds rule sources until receipt commit even when withdrawal uses a different mutex', async () => {
      const f = await leased(false, true),
        output = await proof(f);
      let unlock!: () => void, acquired!: (pid: number) => void;
      const gate = new Promise<void>((r) => {
        unlock = r;
      });
      const ready = new Promise<number>((r) => {
        acquired = r;
      });
      const held = db.begin(async (tx) => {
        // The current-source check can read this row, but receipt progress
        // must wait here. Its resolved rule lock must survive that wait.
        await tx`select memory_id from allrice_experience_reviews where memory_id=${f.candidate.id} for share`;
        acquired((await tx`select pg_backend_pid() pid`)[0]!.pid);
        await gate;
      });
      const blockingPid = await ready;
      const completion = completeJob({ ...f.lease, result: output });
      let withdrawal: Promise<unknown> | undefined;
      try {
        await expect
          .poll(
            async () =>
              Number(
                (
                  await db`select count(*) n from pg_stat_activity where ${blockingPid}=any(pg_blocking_pids(pid))`
                )[0]!.n,
              ),
            { timeout: 3000 },
          )
          .toBeGreaterThan(0);
        withdrawal = db.begin(async (tx) => {
          // The company-asset API uses this row update, not employee-content.
          await tx`update allrice_company_assets set state='withdrawn',revision=revision+1 where id=${f.current!.contentId}`;
        });
        await expect
          .poll(
            async () =>
              Number(
                (
                  await db`select count(*) n from pg_stat_activity where query like '%update allrice_company_assets set state=%' and cardinality(pg_blocking_pids(pid))>0`
                )[0]!.n,
              ),
            { timeout: 3000 },
          )
          .toBeGreaterThan(0);
      } finally {
        unlock();
        await held;
        await completion;
        await withdrawal;
      }
      expect(
        (
          await db`select experience_receipt from allrice_automation_runs where id=${f.occurrence.id}`
        )[0]!.experience_receipt.state,
      ).toBe('pending_validation');
      await expect(
        getExperienceExecution(f.occurrence.run_id),
      ).rejects.toMatchObject({ code: 'source_changed' });
    });
    it('does not accept a model claim of Skill loading', async () => {
      const f = await leased(),
        output = await proof(f, false);
      await expect(completeJob({ ...f.lease, result: output })).rejects.toThrow(
        'EXPERIENCE_EXECUTION_PROOF_REQUIRED',
      );
      expect((await listExperienceDrafts(f.owner))[0]!.drafts).toEqual([]);
    });
    it('forgetting a source blocks late completion and never reserves it again', async () => {
      const f = await leased(),
        output = await proof(f);
      await deleteWorkspaceMemory(f.owner, f.workspace, f.candidate.id);
      await expect(completeJob({ ...f.lease, result: output })).rejects.toThrow(
        'source_changed',
      );
      expect(await listExperienceDrafts(f.owner)).toEqual([]);
      const [r] =
        await db`select consolidation_occurrence_id from allrice_experience_reviews where memory_id=${f.candidate.id}`;
      expect(r!.consolidation_occurrence_id).toBe(f.occurrence.id);
    });
    it('keeps the watermark, refuses employee configuration writes and stops a stale batch on policy change', async () => {
      const f = await leased(),
        output = await proof(f),
        policy = await readExperiencePolicy(f.org);
      const update = {
        expectedRevision: policy.revision,
        frequency: 'off',
        timezone: 'Asia/Shanghai',
        time: '03:00',
        weekday: 1,
        monthDay: 1,
      };
      await expect(
        updateExperiencePolicy(f.owner, f.org, update),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const changed = await updateExperiencePolicy(f.reviewer, f.org, update);
      expect(changed.collectionStartedAt).toBe(policy.collectionStartedAt);
      await completeJob({ ...f.lease, result: output }); // Existing cancellation wins; no draft is published.
      expect(
        (
          await db`select experience_receipt from allrice_automation_runs where id=${f.occurrence.id}`
        )[0]!.experience_receipt,
      ).toBeNull();
      expect(
        (
          await db`select state from allrice_runs where id=${f.occurrence.run_id}`
        )[0]!.state,
      ).toBe('canceled');
    });
    it('records empty periods without a Run or model execution', async () => {
      const f = await source();
      await deleteWorkspaceMemory(f.owner, f.workspace, f.candidate.id);
      await db`update allrice_automations set next_run_at=clock_timestamp()-interval '1 second' where id=${f.rule.id}`;
      await claimDueAutomations();
      const [row] =
        await db`select * from allrice_automation_runs where automation_id=${f.rule.id}`;
      expect(row).toMatchObject({
        run_id: null,
        status: 'succeeded',
        error_code: 'EXPERIENCE_NO_NEW_EVIDENCE',
        experience_execution: null,
      });
    });
    it('does not rewrite the model or Skill pin after preparation', async () => {
      const f = await queued();
      const frozen = await prepareExperienceExecution(f.occurrence.id);
      await expect(
        db`update allrice_automation_runs set experience_execution=${db.json({ ...frozen, model: { ...frozen.model, model: 'another' } })} where id=${f.occurrence.id}`,
      ).rejects.toThrow('occurrence is immutable');
    });
    it('pauses an archived earliest rule while later private and ordinary schedules still dispatch', async () => {
      const bad = await source(),
        good = await source();
      await db`update allrice_employee_instances set archived_at=clock_timestamp() where id=${bad.instance.id}`;
      await db`update allrice_automations set next_run_at=clock_timestamp()-interval '2 minutes' where id=${bad.rule.id}`;
      await db`update allrice_automations set next_run_at=clock_timestamp()-interval '1 minute' where id=${good.rule.id}`;
      const [plain] =
        await db`insert into allrice_automations(organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,conversation_mode,employee_assignment_id,next_run_at)
        select organization_id,workspace_id,owner_id,'普通定时任务','描述一次对账步骤','schedule',schedule,'enabled','new_each_run',employee_assignment_id,clock_timestamp()-interval '30 seconds' from allrice_automations where id=${good.rule.id} returning id`;
      await claimDueAutomations();
      expect(
        (
          await db`select status from allrice_automations where id=${bad.rule.id}`
        )[0]!.status,
      ).toBe('paused');
      expect(
        (
          await db`select run_id from allrice_automation_runs where automation_id=${good.rule.id}`
        )[0]!.run_id,
      ).toBeTruthy();
      expect(
        (
          await db`select run_id from allrice_automation_runs where automation_id=${plain!.id}`
        )[0]!.run_id,
      ).toBeTruthy();
    });
    it('serializes first materialization with an organization policy update', async () => {
      const f = await source(false, false),
        policy = await readExperiencePolicy(f.org);
      const [next] = await Promise.all([
        updateExperiencePolicy(f.reviewer, f.org, {
          expectedRevision: policy.revision,
          frequency: 'monthly',
          timezone: 'Asia/Shanghai',
          time: '03:00',
          weekday: 1,
          monthDay: 15,
        }),
        syncExperienceConsolidationSchedules(),
      ]);
      const [rule] =
        await db`select * from allrice_automations where owner_id=${f.user} and experience_binding is not null`;
      expect(rule!.experience_binding.policyDigest).toBe(
        runtimePolicyDigest(next),
      );
      expect(rule!.schedule.frequency).toBe('monthly');
      expect(rule!.status).toBe('enabled');
    });
    it.each(['revoked', 'expired', 'expired-source'] as const)(
      'rechecks %s after a content-lock wait without committing a draft or losing usage',
      async (kind) => {
        const f = await leased(true),
          output = await proof(f);
        let unlock!: () => void, acquired!: (pid: number) => void;
        const gate = new Promise<void>((r) => (unlock = r)),
          ready = new Promise<number>((r) => (acquired = r));
        const held = db.begin(async (tx) => {
          if (kind === 'expired-source')
            await tx`select memory_id from allrice_experience_reviews where memory_id=${f.candidate.id} for share`;
          else
            await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${f.org}`},0))`;
          if (kind === 'revoked')
            await tx`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1 where id=${f.pin!.bindingId}`;
          acquired((await tx`select pg_backend_pid() pid`)[0]!.pid);
          await gate;
        });
        const pid = await ready;
        if (kind.startsWith('expired'))
          await db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '1 second' where id=${f.job.id}`;
        const completion = completeJob({ ...f.lease, result: output }).then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        );
        try {
          await expect
            .poll(
              async () =>
                Number(
                  (
                    await db`select count(*) n from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))`
                  )[0]!.n,
                ),
              { timeout: 3000 },
            )
            .toBeGreaterThan(0);
          if (kind.startsWith('expired')) await db`select pg_sleep(1.1)`;
        } finally {
          unlock();
          await held;
        }
        const result = await completion;
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.error).toMatchObject({
            code: kind.startsWith('expired') ? 'lease_lost' : 'unavailable',
          });
        expect(
          (
            await db`select experience_receipt from allrice_automation_runs where id=${f.occurrence.id}`
          )[0]!.experience_receipt,
        ).toBeNull();
        expect(
          await db`select l.id from allrice_model_usage_ledger l join allrice_route_decisions d on d.id=l.route_decision_id where d.run_id=${f.occurrence.run_id}`,
        ).toHaveLength(1);
        if (kind === 'revoked')
          expect(await listExperienceDrafts(f.owner)).toEqual([]);
      },
    );
  },
);
