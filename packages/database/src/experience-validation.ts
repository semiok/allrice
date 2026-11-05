import { readContentPrincipal } from './content-maintenance.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type postgres from 'postgres';
import {
  ExperienceModelSnapshotSchema,
  ExperienceValidationViewSchema,
  ExperienceValidationAssertionSchema,
  RouteDecisionSchema,
  evaluateExperienceRoster,
  experienceRosterCase,
  DshNativeSkillSnapshotSchema,
  PersonalSkillSnapshotSchema,
  type PlatformEmployeeTestRunOutput,
} from '@allrice/contracts';

import { ExperienceError } from './experience.ts';
import type { readExperienceValidationSource } from './experience-consolidation.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

import {
  admitModelExecutionInTransaction,
  ModelGovernanceError,
} from './providers/model-governance.ts';

import { assertFrozenPersonalSkills } from './employees/personal-skills.ts';
import {
  experienceSkillDependencies,
  assertExperienceSkillsCurrent,
} from './experience-skill-dependencies.ts';

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
const deny = (): never => {
  throw new ExperienceError('source_changed');
};

async function current(
  tx: Tx,
  b: Binding,
): Promise<Awaited<ReturnType<typeof readExperienceValidationSource>>> {
  void tx;
  void b;
  throw new ExperienceError('disabled');
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

/** Do not create validation plans or tests from retained old receipts. */
export async function syncExperienceValidations() {}

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
  await current(tx, claim.binding);
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
  void id;
  void execution;
  return false;
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
  // A late result keeps its actual usage/route outcome below, but can never
  // become a passing proof for the retired automatic-adoption writer.
  let assertion = {
    ...evaluateExperienceRoster(null, true),
    passed: false,
    reason: 'authority_changed',
  };
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
