import { readContentPrincipal } from './content-maintenance.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  newCurrentPlatformTestOrigin,
  freezePlatformTestExecutionBinding,
} from './conversation/current-platform-test-binding.ts';
import type postgres from 'postgres';
import {
  ExperienceModelSnapshotSchema,
  ExperienceValidationViewSchema,
  ExperienceValidationAssertionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  RouteDecisionSchema,
  evaluateExperienceRoster,
  experienceRosterCase,
  DshNativeSkillSnapshotSchema,
  PersonalSkillSnapshotSchema,
  supportedExperienceRule,
  type PlatformEmployeeTestRunOutput,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { experienceReviewEnabled, ExperienceError } from './experience.ts';
import {
  readExperiencePolicy,
  readExperienceValidationSource,
} from './experience-consolidation.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { freezeExperienceModelSnapshot } from './providers/model-pool.ts';
import {
  admitModelExecutionInTransaction,
  ModelGovernanceError,
} from './providers/model-governance.ts';
import { assertEmployeeMethodModelCurrent } from './employees/employee-method-tests.ts';
import { EmployeeInstanceError } from './employees/employee-instances.ts';
import {
  PersonalSkillError,
  assertFrozenPersonalSkills,
} from './employees/personal-skills.ts';
import {
  experienceSkillDependencies,
  freezeExperienceSkills,
  assertExperienceSkillsCurrent,
} from './experience-skill-dependencies.ts';
import { matchSuccessfulPersonalSkillLoad } from './experience-evidence.ts';
import { validatePlatformEmployeeTestExecutionSnapshot } from './platform-employees/runtime-package.ts';
import {
  recordRouteDecisionInTransaction,
  completeRouteDecisionInTransaction,
} from './execution/route-decision.ts';

type Tx = postgres.TransactionSql;
const uuid = z.string().uuid(),
  digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const LegacyBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: uuid,
    occurrenceId: uuid,
    organizationId: uuid,
    workspaceId: uuid,
    ownerId: uuid,
    employeeId: uuid,
    assignmentId: uuid,
    instanceId: uuid,
    employeeVersionId: uuid,
    draftIndex: z.number().int().min(0).max(7),
    outputDigest: digest,
    draftDigest: digest,
    sourceDigest: digest,
    policyDigest: digest,
    caseId: z.literal(experienceRosterCase.id),
    caseDigest: digest,
    model: ExperienceModelSnapshotSchema,
    timeoutMs: z.number().int().positive().max(300000),
  })
  .strict();
const BindingSchema = z.discriminatedUnion('schemaVersion', [
  LegacyBindingSchema,
  LegacyBindingSchema.extend({
    schemaVersion: z.literal(2),
    personalSkills: PersonalSkillSnapshotSchema,
    nativeSkills: z.array(DshNativeSkillSnapshotSchema).min(1).max(8),
  }).strict(),
]);
type Binding = z.infer<typeof BindingSchema>;
const coverageReason = '尚无完整规则及技能联合覆盖，仍待验证。';
const coverageRecognizer = 'attendance-complete-clauses-v2';
const limited = (e: unknown) =>
  e instanceof ExperienceError ||
  e instanceof DataAccessError ||
  e instanceof EmployeeInstanceError ||
  e instanceof PersonalSkillError ||
  e instanceof ModelGovernanceError;
const deny = (): never => {
  throw new ExperienceError('source_changed');
};

/** Case selection is only a bounded test suggestion, NEVER adoption authority. */
export function supportsRosterValidation(
  draft: { rule: string; applicability: string },
  sources: { excerpt: string; evidence: { skills: unknown[] } }[],
) {
  const text = `${draft.rule}\n${draft.applicability}`;
  return (
    /(?:到场|签到)/u.test(text) &&
    /(?:名单|名册)/u.test(text) &&
    /(?:未到|未签到|缺席)/u.test(text) &&
    /(?:人数|计数|统计)/u.test(text) &&
    sources.some((s) => /(?:到场|签到)/u.test(s.excerpt))
  );
}
function prompt() {
  return JSON.stringify({
    task: '按提供的经验草稿处理四份相互独立的合成样例。present=到场，absent=未到，unknown=状态不明。只返回 JSON。不要用原任务的汇总数字替代这些名单。',
    samples: experienceRosterCase.samples,
    output: {
      results: [
        {
          id: '样例 id',
          status: 'counted',
          present: { count: '整数', ids: ['名单中的 id'] },
          absent: { count: '整数', ids: ['名单中的 id'] },
          total: '整数',
        },
        { id: '缺少必要信息的样例 id', status: 'needs_information' },
      ],
    },
    constraints:
      '每个样例恰好一项结果。能依草稿核对时分项列出成员和人数；缺少必要信息时只返回 id 和 needs_information，不能猜测。不要输出自评通过、预期答案或其他字段。',
  });
}
async function current(tx: Tx, b: Binding) {
  if (!experienceReviewEnabled()) return deny();
  const policy = await readExperiencePolicy(b.organizationId, tx);
  if (
    !('validationMode' in policy) ||
    policy.validationMode !== 'supported_cases' ||
    policy.frequency === 'off' ||
    runtimePolicyDigest(policy) !== b.policyDigest
  )
    return deny();
  const source = await readExperienceValidationSource(
    tx,
    b.occurrenceId,
    b.draftIndex,
  );
  const { occurrence: o, receipt } = source,
    draft = receipt.output.drafts[b.draftIndex];
  if (
    !draft ||
    o.organizationId !== b.organizationId ||
    o.workspaceId !== b.workspaceId ||
    o.ownerId !== b.ownerId ||
    o.employeeId !== b.employeeId ||
    o.instanceId !== b.instanceId ||
    o.assignmentId !== b.assignmentId ||
    o.employeeVersionId !== b.employeeVersionId ||
    receipt.outputDigest !== b.outputDigest ||
    runtimePolicyDigest(draft) !== b.draftDigest ||
    runtimePolicyDigest(o.sources) !== b.sourceDigest ||
    b.caseDigest !== runtimePolicyDigest(experienceRosterCase) ||
    b.model.occurrenceId !== b.id
  )
    return deny();
  await checkDependencies(tx, b, source);
  await assertEmployeeMethodModelCurrent(
    tx,
    { organization_id: b.organizationId },
    b.model,
  );
  return source;
}

async function checkDependencies(
  tx: Tx,
  b: Binding,
  source: Awaited<ReturnType<typeof readExperienceValidationSource>>,
) {
  const draft = source.receipt.output.drafts[b.draftIndex]!;
  const required = experienceSkillDependencies(
    b.instanceId,
    source.occurrence.sources.filter((s) => draft.sourceIds.includes(s.id)),
  );
  if (b.schemaVersion === 1) {
    if (required) return deny();
    return;
  }
  if (
    !required ||
    runtimePolicyDigest(required) !== runtimePolicyDigest(b.personalSkills)
  )
    return deny();
  assertFrozenPersonalSkills(b.personalSkills, b.nativeSkills, b.instanceId);
  if (
    b.nativeSkills.some(
      (s) =>
        s.personal?.packageChecksum || s.bundle || s.requiredToolRefs.length,
    )
  )
    return deny();
  await assertExperienceSkillsCurrent(
    tx,
    {
      organizationId: b.organizationId,
      workspaceId: b.workspaceId,
      actor: { type: 'user', id: b.ownerId },
    },
    b.personalSkills,
  );
}
async function binding(tx: Tx, id: string) {
  const [row] =
    await tx`select experience_binding from allrice_platform_employee_test_runs where id=${id} and purpose='experience_validation'`;
  if (!row) return deny();
  const b = BindingSchema.parse(row.experience_binding);
  if (b.id !== id) return deny();
  return b;
}

/** Existing background tick, one immutable reservation per original draft. */
export async function syncExperienceValidations() {
  if (!experienceReviewEnabled()) return;
  const db = getDatabase();
  const rows = await db`select a.id from allrice_automation_runs a
    left join allrice_settings org on org.scope_type='organization' and org.scope_id=a.organization_id and org.key='employee_experience_policy'
    left join allrice_settings sys on sys.scope_type='system' and sys.scope_id is null and sys.key='employee_experience_policy'
    where a.status='succeeded' and not exists(select 1 from allrice_native_context_retirements retired where retired.context_kind='experience_consolidation' and retired.context_id=a.id) and a.experience_receipt is not null and (a.experience_validation_plan is null or exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(a.experience_validation_plan)='array' then a.experience_validation_plan else '[]'::jsonb end) p
      where p->>'reason'=${coverageReason} and p->>'draftIndex' ~ '^[0-7]$' and not (p ? 'testId')
        and not exists(select 1 from allrice_platform_employee_test_runs t where t.purpose='experience_validation'
          and t.experience_binding->>'occurrenceId'=a.id::text and t.experience_binding->>'draftIndex'=p->>'draftIndex')
        and not exists(select 1 from allrice_experience_coverage_reassessments r where r.occurrence_id=a.id
          and r.draft_index::text=p->>'draftIndex' and r.recognizer_version=${coverageRecognizer})))
    and coalesce(org.value,sys.value)->>'validationMode'='supported_cases'
    and coalesce(org.value,sys.value)->>'frequency'<>'off' order by a.created_at,a.id limit 8`;
  for (const { id } of rows) {
    await db.begin(async (tx) => {
      const [row] =
        await tx`select id,organization_id,experience_validation_plan,experience_adoption_plan,experience_receipt
          from allrice_automation_runs where id=${id} for update skip locked`;
      if (!row) return;
      // A captured tick must recheck after the source lock, before any consumer write.
      if (
        (
          await tx`select 1 from allrice_native_context_retirements where context_kind='experience_consolidation' and context_id=${id}`
        ).length
      )
        return;
      const reassessing = row.experience_validation_plan !== null;
      const pending = new Set<number>();
      if (reassessing) {
        // Recheck after the occurrence lock: another tick may already have
        // reserved a test or recorded a denied/unsupported reassessment.
        const recorded =
          await tx`select draft_index from allrice_experience_coverage_reassessments
          where occurrence_id=${id} and recognizer_version=${coverageRecognizer}`;
        const tests =
          await tx`select experience_binding->>'draftIndex' draft_index from allrice_platform_employee_test_runs
          where purpose='experience_validation' and experience_binding->>'occurrenceId'=${id}`;
        const done = new Set(
          [...recorded, ...tests].map((r) => Number(r.draft_index)),
        );
        for (const entry of z
          .array(
            z.object({
              draftIndex: z.number().int().min(0).max(7).optional(),
              reason: z.string().optional(),
              testId: uuid.optional(),
            }),
          )
          .parse(row.experience_validation_plan)) {
          if (
            entry.reason === coverageReason &&
            entry.testId === undefined &&
            entry.draftIndex !== undefined &&
            !done.has(entry.draftIndex)
          )
            pending.add(entry.draftIndex);
        }
        if (!pending.size) return;
      }
      type Plan = { draftIndex: number; testId?: string; reason?: string };
      const savePlan = async (plan: Plan[]) => {
        if (!reassessing) {
          await tx`update allrice_automation_runs set experience_validation_plan=${tx.json(plan)} where id=${id}`;
          return;
        }
        for (const entry of plan) {
          const draft = row.experience_receipt.output.drafts[entry.draftIndex];
          if (!draft || !pending.has(entry.draftIndex)) continue;
          await tx`insert into allrice_experience_coverage_reassessments
            (occurrence_id,draft_index,recognizer_version,prior_plan_digest,output_digest,draft_digest,test_id,reason)
            values(${id},${entry.draftIndex},${coverageRecognizer},${runtimePolicyDigest(row.experience_validation_plan)},
              ${row.experience_receipt.outputDigest},${runtimePolicyDigest(draft)},${entry.testId ?? null},${entry.reason ?? null})`;
        }
        const previous = row.experience_adoption_plan;
        if (
          previous &&
          ['complete', 'awaiting_validation'].includes(previous.status) &&
          Array.isArray(previous.drafts)
        ) {
          const resumed = plan
            .filter(
              (p) =>
                p.testId &&
                previous.drafts.some(
                  (d: { draftIndex: number; reason?: string }) =>
                    d.draftIndex === p.draftIndex &&
                    d.reason === '尚无覆盖完整规则及依赖的验证，未采用。',
                ),
            )
            .map((p) => p.draftIndex);
          if (resumed.length)
            await tx`update allrice_automation_runs set experience_adoption_plan=${tx.json(
              {
                ...previous,
                status: 'awaiting_validation',
                pendingDrafts: [
                  ...new Set([...(previous.pendingDrafts ?? []), ...resumed]),
                ],
              },
            )} where id=${id}`;
        }
      };
      const denyPlan = async (reason: string) => {
        if (reassessing)
          await savePlan(
            [...pending].map((draftIndex) => ({ draftIndex, reason })),
          );
        else
          await tx`update allrice_automation_runs set experience_validation_plan=${tx.json([{ reason }])} where id=${id}`;
      };
      const policy = await readExperiencePolicy(row.organization_id, tx);
      if (
        !('validationMode' in policy) ||
        policy.validationMode !== 'supported_cases' ||
        policy.frequency === 'off'
      )
        return;
      let source;
      try {
        source = await readExperienceValidationSource(tx, id);
      } catch (e) {
        if (!limited(e)) throw e;
        await denyPlan('来源、实例或有效要求已变化，原草稿未启用。');
        return;
      }
      const { occurrence: o, receipt } = source;
      await tx`select pg_advisory_xact_lock(hashtext('experience-validation-daily-budget'))`;
      const [budget] = await tx`select count(*)::int global_count,
        count(*) filter(where experience_binding->>'organizationId'=${o.organizationId})::int org_count
        from allrice_platform_employee_test_runs where purpose='experience_validation' and created_at>clock_timestamp()-interval '24 hours'`;
      if (budget!.global_count >= 64 || budget!.org_count >= 8) return;
      const [base] =
        await tx`select r.employee_id,r.id,r.runtime_profile,r.definition,r.checksum from allrice_employee_version_sources s
        join allrice_platform_employee_revisions r on r.id=s.platform_revision_id and r.employee_id=s.platform_employee_id
        where s.employee_version_id=${o.employeeVersionId} and s.employee_id=${o.employeeId} and s.organization_id=${o.organizationId}
          and s.workspace_id=${o.workspaceId} and r.status='published' for share of r`;
      if (!base) {
        await denyPlan('原发布版本缺少可核验的运行包，尚未验证或启用。');
        return;
      }
      const profile = PlatformEmployeeRuntimeProfileSchema.parse(
        base.runtime_profile,
      );
      const frozen = validatePlatformEmployeeTestExecutionSnapshot({
        runtimeProfile: profile,
        definition: base.definition,
        nativeSkills: profile.runtimePackage?.skills,
        packageChecksum: profile.runtimePackage?.checksum ?? null,
      });
      const plan: Plan[] = [];
      let remaining = Math.min(
        64 - budget!.global_count,
        8 - budget!.org_count,
      );
      for (const [draftIndex, draft] of receipt.output.drafts.entries()) {
        if (reassessing && !pending.has(draftIndex)) continue;
        const sources = o.sources.filter((s) => draft.sourceIds.includes(s.id));
        if (!supportsRosterValidation(draft, sources)) {
          plan.push({
            draftIndex,
            reason: `草稿 ${draftIndex + 1} 暂无覆盖其要求的独立专项样例，仍待验证。`,
          });
          continue;
        }
        let skills;
        try {
          await readExperienceValidationSource(tx, id, draftIndex);
          if (
            sources.some((s) => s.evidence.skills.length) &&
            supportedExperienceRule(draft)?.kind !== 'attendance_groups'
          ) {
            plan.push({
              draftIndex,
              reason: coverageReason,
            });
            continue;
          }
          skills = await freezeExperienceSkills(
            tx,
            {
              organizationId: o.organizationId,
              workspaceId: o.workspaceId,
              actor: { type: 'user', id: o.ownerId },
            },
            o.instanceId,
            sources,
          );
        } catch (e) {
          if (!limited(e)) throw e;
          plan.push({
            draftIndex,
            reason:
              '此草稿的来源或当前技能版本已变化，或需尚未覆盖的资源，未启动验证。',
          });
          continue;
        }
        if (remaining-- <= 0) {
          // No paid attempt or denial happened. Leave this draft eligible for
          // a later tick rather than consuming its one reassessment on budget.
          if (reassessing) continue;
          plan.push({
            draftIndex,
            reason: `草稿 ${draftIndex + 1} 未进入本批验证预算，仍待验证。`,
          });
          continue;
        }
        const testId = randomUUID();
        const model = await freezeExperienceModelSnapshot({
          ...o,
          occurrenceId: testId,
        });
        const b = BindingSchema.parse({
          ...(skills ? { schemaVersion: 2, ...skills } : { schemaVersion: 1 }),
          id: testId,
          occurrenceId: id,
          organizationId: o.organizationId,
          workspaceId: o.workspaceId,
          ownerId: o.ownerId,
          employeeId: o.employeeId,
          assignmentId: o.assignmentId,
          instanceId: o.instanceId,
          employeeVersionId: o.employeeVersionId,
          draftIndex,
          outputDigest: receipt.outputDigest,
          draftDigest: runtimePolicyDigest(draft),
          sourceDigest: runtimePolicyDigest(o.sources),
          policyDigest: runtimePolicyDigest(policy),
          caseId: experienceRosterCase.id,
          caseDigest: runtimePolicyDigest(experienceRosterCase),
          model,
          timeoutMs: Math.min(model.runLimits.timeoutMs, 300000),
        });
        const executionSource = {
          platformEmployeeId: base.employee_id,
          platformRevisionId: base.id,
          purpose: 'experience_validation' as const,
          definitionChecksum: base.checksum,
          definition: frozen.definition,
          runtimeProfile: frozen.runtimeProfile,
          nativeSkills: frozen.nativeSkills,
          packageChecksum: profile.runtimePackage!.checksum,
        };
        const executionScope = {
          organizationId: o.organizationId,
          workspaceId: o.workspaceId,
          ownerId: o.ownerId,
          testId,
        };
        const origin = newCurrentPlatformTestOrigin({
          scope: executionScope,
          source: executionSource,
        });
        const nativeBinding = freezePlatformTestExecutionBinding({
          origin,
          scope: executionScope,
          source: executionSource,
        });
        await tx`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,
          frozen_runtime_profile,frozen_definition,frozen_native_skills,frozen_package_checksum,purpose,experience_binding,native_root_origin,native_execution_binding)
          values(${testId},${base.employee_id},${base.id},${o.ownerId},'queued',${tx.json({ prompt: prompt(), environment: 'platform', workspaceId: o.workspaceId, ownerId: o.ownerId })},
            ${tx.json(frozen.runtimeProfile)},${tx.json(frozen.definition)},${tx.json(frozen.nativeSkills)},${profile.runtimePackage!.checksum},'experience_validation',${tx.json(b)},${tx.json(origin)},${tx.json(nativeBinding)})`;
        plan.push({ draftIndex, testId });
      }
      await savePlan(plan);
    });
  }
}

export async function prepareExperienceValidationClaim(tx: Tx, id: string) {
  const b = await binding(tx, id);
  // Take the final user lock before content locks; claim must not upgrade a
  // SHARE user lock while a concurrent content writer waits behind us.
  if (
    !(await readContentPrincipal(
      {
        organizationId: b.organizationId,
        workspaceId: b.workspaceId,
        actor: { type: 'user', id: b.ownerId },
      },
      tx,
      'update_user',
    ))
  )
    return deny();
  const source = await current(tx, b);
  // Same cross-worker slot as consolidation. Foreground work always goes first.
  const [slot] =
    await tx`select pg_try_advisory_xact_lock(hashtext('experience-background-slot')) locked`;
  const [busy] =
    await tx`select count(*)::int n from allrice_jobs where status in ('queued','claimed','running','waiting_approval','retry_wait')`;
  if (!slot?.locked || busy!.n > 0) {
    await tx`update allrice_platform_employee_test_runs set available_at=clock_timestamp()+interval '3 seconds' where id=${id}`;
    return null;
  }
  try {
    await admitModelExecutionInTransaction(
      {
        organizationId: b.organizationId,
        workspaceId: b.workspaceId,
        userId: b.ownerId,
        employeeId: b.employeeId,
        connectionId: b.model.connectionId,
        requestedTokens: b.model.runLimits.maxTotalTokens,
        requestedRuntimeMs: b.timeoutMs,
      },
      tx,
    );
  } catch (e) {
    if (
      !(e instanceof ModelGovernanceError) ||
      e.code !== 'MODEL_RESOURCE_CONCURRENCY_EXCEEDED'
    )
      throw e;
    await tx`update allrice_platform_employee_test_runs set available_at=clock_timestamp()+interval '3 seconds' where id=${id}`;
    return null;
  }
  const [p] =
    await tx`select m.id membership_id,m.role,w.name workspace_name from allrice_memberships m
    join allrice_workspaces w on w.id=${b.workspaceId} and w.organization_id=m.organization_id and w.archived_at is null
    where m.user_id=${b.ownerId} and m.organization_id=${b.organizationId} and m.active
      and (m.workspace_id is null or m.workspace_id=w.id) order by m.id limit 1`;
  if (!p) return deny();
  const draft = source.receipt.output.drafts[b.draftIndex]!;
  return {
    binding: b,
    timeoutMs: b.timeoutMs,
    modelSnapshot: b.model,
    instructions: `这是平台隔离的经验专项验证。严格按下列固定草稿处理合成样例，不要替草稿补方法或改错。草稿尚未启用。${b.schemaVersion === 2 ? `先用原生 skill 加载全部指定个人技能：${b.nativeSkills.map((s) => s.name).join('、')}；只允许读取这些已冻结的技能正文。` : '不得调用工具。'}不得读取其他资料、运行命令、改写内容或发布。返回要求的 JSON，不提供自评结论。\n${JSON.stringify({ rule: draft.rule, applicability: draft.applicability, outputDigest: b.outputDigest, draftDigest: b.draftDigest })}`,
    previewContext: {
      organization_id: b.organizationId,
      workspace_id: b.workspaceId,
      owner_id: b.ownerId,
      membership_id: p.membership_id as string,
      role: p.role as 'member' | 'admin',
      workspace_name: p.workspace_name as string,
    },
  };
}
export async function recordExperienceValidationExecution(
  tx: Tx,
  claim: NonNullable<
    Awaited<ReturnType<typeof prepareExperienceValidationClaim>>
  >,
  runId: string,
) {
  const b = claim.binding,
    m = b.model;
  const decision = await recordRouteDecisionInTransaction(
    RouteDecisionSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      runId,
      organizationId: b.organizationId,
      workspaceId: b.workspaceId,
      actorId: b.ownerId,
      employeeId: b.employeeId,
      inputChecksum: runtimePolicyDigest(b),
      candidates: [
        {
          id: b.caseId,
          kind: 'direct',
          name: '隔离名单专项验证',
          bindingId: null,
          requiredCapabilities: ['model:invoke'],
          risk: 'low',
          requiresApproval: false,
          authorized: true,
          exclusionReason: null,
          score: 100,
        },
      ],
      selectedKind: 'direct',
      selectedCandidateId: b.caseId,
      harness: m.harness,
      provider: m.provider,
      model: m.model,
      modelConnectionId: m.connectionId,
      modelCatalogEntryId: m.modelCatalogEntryId,
      modelPolicyRevision: m.policyRevision,
      generation: 0,
      attempt: 1,
      reasonCodes: ['minimum_necessary_capability'],
      createdAt: new Date().toISOString(),
    }),
    tx,
  );
  await tx`update allrice_platform_employee_test_runs set experience_run_id=${runId},experience_route_id=${decision.id} where id=${b.id} and experience_run_id is null`;
  return {
    caseId: b.caseId,
    occurrenceId: b.id,
    assignmentId: b.assignmentId,
    employeeVersionId: b.employeeVersionId,
    modelSnapshot: m,
    timeoutMs: b.timeoutMs,
    instructions: claim.instructions,
    ...(b.schemaVersion === 2
      ? { nativeSkills: b.nativeSkills, personalSkills: b.personalSkills }
      : {}),
    decision,
  };
}
export async function experienceValidationStillCurrent(
  id: string,
  execution: {
    runId: string;
    jobId: string;
    workerId: string;
    leaseToken: string;
  },
) {
  return getDatabase().begin(async (tx) => {
    // Same test -> Job -> Run -> authority order as finalization.
    const [test] =
      await tx`select id,experience_run_id,experience_binding from allrice_platform_employee_test_runs
      where id=${id} and purpose='experience_validation' and status='running' for share`;
    if (!test || test.experience_run_id !== execution.runId) return false;
    const b = BindingSchema.parse(test.experience_binding);
    await tx`select id from allrice_jobs
      where id=${execution.jobId} and run_id=${execution.runId} for share`;
    const [job] =
      await tx`select j.id from allrice_jobs j join allrice_runs r on r.id=j.run_id
      where j.id=${execution.jobId} and r.id=${execution.runId}
      and j.organization_id=${b.organizationId} and r.organization_id=j.organization_id
      and j.workspace_id=${b.workspaceId} and r.workspace_id=j.workspace_id
      and j.owner_id=${b.ownerId} and r.owner_id=j.owner_id
      and r.execution_spec->>'platformEmployeeTestRunId'=${id}
      and r.execution_spec->>'experienceValidationDigest'=${b.draftDigest}
      and r.state='running' and j.status='running' and j.cancel_requested_at is null
      and j.worker_id=${execution.workerId} and j.lease_token=${execution.leaseToken}
      and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() for share of r,j`;
    if (!job) return false;
    await current(tx, b);
    const [live] =
      await tx`select 1 from allrice_platform_employee_test_runs t join allrice_jobs j on j.id=${execution.jobId}
      where t.id=${id} and t.started_at+(${b.timeoutMs}*interval '1 millisecond')>clock_timestamp()
      and t.timeout_at>clock_timestamp() and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()`;
    return !!live;
  });
}
export async function finishExperienceValidation(
  tx: Tx,
  id: string,
  output: PlatformEmployeeTestRunOutput,
  status: 'succeeded' | 'failed' | 'canceled',
) {
  const b = await binding(tx, id);
  const [row] =
    await tx`select t.experience_run_id,t.experience_route_id,t.timeout_at,t.started_at,j.attempt job_attempt
      from allrice_platform_employee_test_runs t left join allrice_jobs j on j.run_id=t.experience_run_id where t.id=${id}`;
  let assertion = evaluateExperienceRoster(
    output.answer,
    status !== 'succeeded',
  );
  if (b.schemaVersion === 2) {
    const loaded = new Map(
      output.events.flatMap((event) => {
        if (
          event.type !== 'tool.completed' ||
          event.internalTask?.kind !== 'experience_validation' ||
          event.internalTask.occurrenceId !== id ||
          event.sessionId !== null ||
          event.messageId !== null ||
          event.attempt !== row!.job_attempt ||
          event.generation !== 0 ||
          event.harness !== 'dsh' ||
          event.source !== 'harness'
        )
          return [];
        const pin = matchSuccessfulPersonalSkillLoad(
          b.personalSkills.skills,
          event,
        );
        return pin ? [[pin.bindingId, pin] as const] : [];
      }),
    );
    if (loaded.size !== b.personalSkills.skills.length)
      assertion = {
        ...assertion,
        passed: false,
        reason: 'skill_load_unverified',
      };
    else
      assertion = {
        ...assertion,
        skillValidation: {
          snapshotChecksum: b.personalSkills.checksum,
          loadedPinsChecksum: runtimePolicyDigest(b.personalSkills.skills),
          loadedVersionIds: b.personalSkills.skills.map((p) => p.versionId),
        },
      };
  }
  try {
    await current(tx, b);
  } catch (e) {
    if (!limited(e)) throw e;
    assertion = { ...assertion, passed: false, reason: 'authority_changed' };
  }
  const [clock] = await tx`select clock_timestamp() now`;
  if (
    (row!.timeout_at && row!.timeout_at <= clock!.now) ||
    (row!.started_at &&
      row!.started_at.getTime() + b.timeoutMs <= clock!.now.getTime())
  )
    assertion = { ...assertion, passed: false, reason: 'execution_failed' };
  await tx`update allrice_platform_employee_test_runs set experience_assertion=${tx.json(assertion)} where id=${id} and experience_assertion is null`;
  if (!row!.experience_route_id) return;
  const meter = output.modelExecution;
  await completeRouteDecisionInTransaction(
    {
      organizationId: b.organizationId,
      workspaceId: b.workspaceId,
      ...(meter?.dispatched === false
        ? {
            undispatched: {
              subscriptionSnapshotCreated: meter.subscriptionSnapshotCreated,
            },
          }
        : {}),
      outcome: {
        decisionId: row!.experience_route_id,
        status,
        inputTokens: output.usage?.inputTokens ?? 0,
        cachedInputTokens: output.usage?.cachedInputTokens ?? 0,
        outputTokens: output.usage?.outputTokens ?? 0,
        costCents: meter?.costCents ?? null,
        usageComplete: meter?.usageComplete ?? false,
        cacheUsageKnown: meter?.cacheUsageKnown ?? false,
        errorCode: output.error?.code ?? null,
        failureCategory: null,
        completedAt: new Date().toISOString(),
      },
    },
    tx,
  );
}
export async function listExperienceValidationViews(
  tx: Tx,
  occurrenceId: string,
) {
  const rows =
    await tx`select * from allrice_platform_employee_test_runs where purpose='experience_validation'
    and experience_binding->>'occurrenceId'=${occurrenceId} order by created_at,id limit 8`;
  return rows.map((r) => {
    const b = BindingSchema.parse(r.experience_binding);
    const assertion = r.experience_assertion
      ? ExperienceValidationAssertionSchema.parse(r.experience_assertion)
      : null;
    return ExperienceValidationViewSchema.parse({
      id: r.id,
      draftIndex: b.draftIndex,
      caseId: b.caseId,
      status: r.status,
      validationStatus: ['queued', 'running'].includes(r.status)
        ? 'pending'
        : assertion?.passed
          ? 'passed'
          : assertion &&
              [
                'invalid_output',
                'count_or_membership_mismatch',
                'missing_information_inferred',
                'skill_load_unverified',
              ].includes(assertion.reason)
            ? 'failed'
            : 'not_verified',
      runId: r.experience_run_id,
      createdAt: r.created_at.toISOString(),
      completedAt: r.completed_at?.toISOString() ?? null,
      assertion,
      outputDigest: b.outputDigest,
      coverage: experienceRosterCase.coverage,
      active: false,
    });
  });
}

/** A completed proof remains usable when the administrator later enables
 * adoption. Current source/rule authority is checked separately; do not rerun
 * the model merely because the scheduling policy revision changed. */
export async function readPassedExperienceProof(
  tx: Tx,
  source: Awaited<ReturnType<typeof readExperienceValidationSource>>,
  draftIndex: number,
) {
  const { occurrence: o, receipt } = source;
  const draft = receipt.output.drafts[draftIndex];
  const [row] =
    await tx`select id,status,experience_binding,experience_assertion,experience_run_id
    from allrice_platform_employee_test_runs where purpose='experience_validation'
      and experience_binding->>'occurrenceId'=${o.id} and experience_binding->>'draftIndex'=${String(draftIndex)}`;
  if (!row || row.status !== 'succeeded' || !row.experience_run_id || !draft)
    return null;
  const b = BindingSchema.parse(row.experience_binding);
  const assertion = ExperienceValidationAssertionSchema.safeParse(
    row.experience_assertion,
  );
  if (
    !assertion.success ||
    !assertion.data.passed ||
    b.id !== row.id ||
    b.organizationId !== o.organizationId ||
    b.workspaceId !== o.workspaceId ||
    b.ownerId !== o.ownerId ||
    b.instanceId !== o.instanceId ||
    b.employeeId !== o.employeeId ||
    b.assignmentId !== o.assignmentId ||
    b.employeeVersionId !== o.employeeVersionId ||
    b.outputDigest !== receipt.outputDigest ||
    b.draftDigest !== runtimePolicyDigest(draft) ||
    b.sourceDigest !== runtimePolicyDigest(o.sources) ||
    b.caseDigest !== runtimePolicyDigest(experienceRosterCase)
  )
    return null;
  await checkDependencies(tx, b, source);
  if (b.schemaVersion === 2) {
    if (!assertion.data.skillValidation) return null;
    const expected = {
      snapshotChecksum: b.personalSkills.checksum,
      loadedPinsChecksum: runtimePolicyDigest(b.personalSkills.skills),
      loadedVersionIds: b.personalSkills.skills.map((p) => p.versionId),
    };
    if (
      runtimePolicyDigest(assertion.data.skillValidation) !==
      runtimePolicyDigest(expected)
    )
      return null;
    return {
      kind: 'independent_skill_case' as const,
      testId: b.id,
      caseId: b.caseId,
      caseDigest: b.caseDigest,
      dependencies: b.personalSkills,
      skillValidation: expected,
    };
  }
  return {
    kind: 'independent_case' as const,
    testId: b.id,
    caseId: b.caseId,
    caseDigest: b.caseDigest,
  };
}
