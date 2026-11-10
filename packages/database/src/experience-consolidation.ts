import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';

import {
  ExperienceCollectionPolicySchema,
  ExperiencePolicySettingsSchema,
  experiencePolicySchedule,
  UuidSchema,
  PlatformEmployeeDefinitionSchema,
  type EmployeeInstance,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { experienceReviewEnabled, ExperienceError } from './experience.ts';
import { requirePlatformAdmin } from './platform-authority.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  resolveEmployeeSessionInstance,
  EmployeeInstanceError,
  readEmployeeVersionPublication,
  getEmployeeInstanceForHistory,
} from './employees/employee-instances.ts';
import { freezeEmployeeRuntimeContent } from './employees/employee-content.ts';
import { resolveEmployeeContentSource } from './employees/employee-content-sources.ts';
import {
  assertPersonalSkillsReadable,
  PersonalSkillError,
} from './employees/personal-skills.ts';

import { nextScheduleAt } from './execution/automation.ts';
import type { ResourcePrincipal } from './resource-principal.ts';
import {
  ExperienceAutomationBindingSchema,
  ExperienceOccurrenceSchema,
  ExperienceExecutionSchema,
  ExperienceReceiptSchema,
  type ExperienceOccurrence,
} from './experience-consolidation-contracts.ts';

type Tx = postgres.TransactionSql;
export type ExperienceScheduleRule = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  employee_assignment_id: string | null;
  experience_binding: unknown;
  next_run_at: Date | null;
  schedule: unknown;
};
type Rule = ExperienceScheduleRule;
const deny = (): never => {
  throw new ExperienceError('source_changed');
};
const identity = (
  o: Pick<ExperienceOccurrence, 'organizationId' | 'workspaceId' | 'ownerId'>,
) => ({
  actor: { type: 'user' as const, id: o.ownerId },
  organizationId: o.organizationId,
  workspaceId: o.workspaceId,
});
const stableInstance = (instance: Record<string, unknown>) => {
  const frozen = { ...instance };
  delete frozen.createdAt;
  delete frozen.updatedAt;
  delete frozen.archivedAt;
  return runtimePolicyDigest(frozen);
};
/** Reuse the live content resolver; only rules/procedures, never file bodies. */
async function currentRules(
  tx: Tx,
  occurrence: Pick<
    ExperienceOccurrence,
    'organizationId' | 'workspaceId' | 'ownerId' | 'employeeId'
  >,
  instance: EmployeeInstance,
  lock = true,
) {
  const context = identity(occurrence);
  const index = await freezeEmployeeRuntimeContent(
    context,
    {
      instanceId: instance.id,
      employeeId: occurrence.employeeId,
      employeeVersionId: instance.source.employeeVersionId,
    },
    tx,
  );
  const publication = await readEmployeeVersionPublication(
    {
      ...occurrence,
      versionId: instance.source.employeeVersionId,
    },
    tx,
  );
  const definition = publication
    ? PlatformEmployeeDefinitionSchema.parse(publication.definition)
    : null;
  const sources = [];
  for (const layer of index.layers) {
    const refs = [
      ...layer.common,
      ...(layer.scenes ?? []).flatMap((s) => s.references),
    ];
    const unique = new Map(
      refs
        .filter((r) =>
          ['requirement', 'procedure', 'company_rule'].includes(r.sourceKind),
        )
        .map((r) => [runtimePolicyDigest(r), r]),
    );
    for (const ref of unique.values()) {
      const { dto } = await resolveEmployeeContentSource({
        context,
        employeeId: occurrence.employeeId,
        ownership: layer.ownership,
        ref,
        sql: tx,
        // Company asset pause/withdrawal does not take the content mutex.
        // Hold the resolved source rows through the receipt transaction too.
        lock,
        allowDraft: false,
      });
      sources.push({
        reference: dto.reference,
        available: dto.available,
        ...(dto.title ? { title: dto.title } : {}),
        ...(dto.body ? { body: dto.body } : {}),
      });
    }
  }
  return {
    profile: instance.profile,
    index,
    platformRequirements: definition
      ? [
          ...definition.identity.behaviorRules,
          ...definition.identity.safetyBoundaries,
        ]
      : [],
    sources,
  };
}
export async function readExperiencePolicy(
  organizationId: string,
  tx: Tx | ReturnType<typeof getDatabase> = getDatabase(),
  lock = true,
) {
  const rows = await tx<{ scope_type: string; value: unknown }[]>`
    select scope_type,value from allrice_settings where key='employee_experience_policy'
      and ((scope_type='system' and scope_id is null) or (scope_type='organization' and scope_id=${organizationId}))
    order by scope_type ${lock ? tx`for share` : tx``}`;
  return ExperienceCollectionPolicySchema.parse(
    rows.find((r) => r.scope_type === 'organization')?.value ??
      rows.find((r) => r.scope_type === 'system')?.value,
  );
}
export async function getExperiencePolicy(
  context: RequestContext,
  organizationId: string,
) {
  await requirePlatformAdmin(context);
  return readExperiencePolicy(
    UuidSchema.parse(organizationId),
    undefined,
    false,
  );
}
const PolicyUpdateSchema = ExperiencePolicySettingsSchema.extend({
  expectedRevision: z.number().int().positive(),
  validationMode: z.enum(['off', 'supported_cases']).optional(),
  adoptionMode: z.enum(['off', 'supported_private']).optional(),
}).strict();
export async function updateExperiencePolicy(
  context: RequestContext,
  organizationId: string,
  raw: unknown,
) {
  const org = UuidSchema.parse(organizationId),
    input = PolicyUpdateSchema.parse(raw);
  return getDatabase().begin(async (tx) => {
    const actor = await requirePlatformAdmin(context, tx);
    const [login] =
      await tx`select id from allrice_sessions where id=${context.sessionId} and user_id=${actor}
      and revoked_at is null and expires_at>clock_timestamp() for share`;
    if (!login) throw new DataAccessError('authentication_required');
    await tx`select pg_advisory_xact_lock(hashtextextended(${`experience-policy:${org}`},183))`;
    const [company] =
      await tx`select id from allrice_organizations where id=${org} and archived_at is null for share`;
    if (!company) throw new DataAccessError('not_found');
    // Match completion's job-first lock order, then scheduler rule, then policy.
    await tx`select j.id from allrice_jobs j join allrice_automation_runs r on r.run_id=j.run_id
      where r.organization_id=${org} and r.experience_occurrence is not null
        and j.status in ('queued','claimed','running','waiting_approval','retry_wait') order by j.id for update of j`;
    const rules = await tx<
      Rule[]
    >`select * from allrice_automations where organization_id=${org} and experience_binding is not null and deleted_at is null order by id for update`;
    const previous = await readExperiencePolicy(org, tx);
    const { expectedRevision, ...settings } = input;
    if (previous.revision !== expectedRevision)
      throw new ExperienceError('conflict');
    const policy = ExperienceCollectionPolicySchema.parse({
      ...previous,
      ...settings,
      schemaVersion: 4,
      adoptionMode:
        input.adoptionMode ??
        (previous.schemaVersion === 4 ? previous.adoptionMode : 'off'),
      adoptionAuthorizedBy:
        input.adoptionMode === 'supported_private'
          ? actor
          : previous.schemaVersion === 4
            ? previous.adoptionAuthorizedBy
            : null,
      validationMode:
        input.validationMode ??
        ('validationMode' in previous ? previous.validationMode : 'off'),
      revision: previous.revision + 1,
    });
    const { experienceNativeCalendarEnabled } =
      await import('./experience-native.ts');
    if (policy.frequency !== 'off' && !experienceNativeCalendarEnabled())
      throw new ExperienceError('disabled');
    await tx`insert into allrice_settings(scope_type,scope_id,key,value)
      values('organization',${org},'employee_experience_policy',${tx.json(policy)})
      on conflict(scope_type,scope_id,key) do update set value=excluded.value,updated_at=clock_timestamp()`;
    for (const rule of rules) {
      const binding = ExperienceAutomationBindingSchema.parse(
        rule.experience_binding,
      );
      const schedule = experiencePolicySchedule(policy);
      await tx`update allrice_automations set status=${policy.frequency === 'off' ? 'paused' : 'enabled'},
        schedule=${tx.json({ ...schedule, frequency: schedule.frequency === 'off' ? 'weekly' : schedule.frequency })},
        experience_binding=${tx.json({ ...binding, policyDigest: runtimePolicyDigest(policy) })},revision=revision+1,
        next_run_at=${policy.frequency === 'off' ? null : nextScheduleAt(schedule)},updated_at=clock_timestamp() where id=${rule.id}`;
      const { syncExperienceNativePolicyInTransaction } =
        await import('./experience-native.ts');
      await syncExperienceNativePolicyInTransaction(tx, rule.id);
    }
    // An already dispatched batch is interrupted by its normal lease/guard;
    // it can never commit after this policy revision changes.
    await tx`update allrice_jobs j set cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),cancel_reason='experience_policy_changed'
      from allrice_automation_runs r where r.run_id=j.run_id and r.organization_id=${org} and r.experience_occurrence is not null
        and j.status in ('queued','claimed','running','waiting_approval','retry_wait')`;
    await tx`insert into allrice_audit_events(organization_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
      values(${org},${actor},'experience.policy.update','organization',${org},'allowed','private_automatic_consolidation',${context.requestId})`;
    return policy;
  });
}

/** Materialize only instances with NEW captured evidence. No historical chat scan. */
/** No new schedules for the retired experience-consolidation-v1 consumer. */
export async function syncExperienceConsolidationSchedules() {
  return 0;
}

export type ExperienceOccurrenceReservation =
  | { outcome: 'queued' | 'empty' | 'already_claimed'; automationRunId: string }
  | {
      outcome: 'budget';
      budget: {
        globalCount: number;
        organizationCount: number;
        instanceCount: number;
      };
    }
  | { outcome: 'policy_blocked'; reason: 'disabled' | 'policy_changed' };

/** Retained native receipts cannot reserve or replay old business work. */
export async function reserveExperienceOccurrenceInTransaction(
  tx: Tx,
  rule: Rule,
  scheduledFor: Date,
  nativeRecurringOccurrenceId: string | null = null,
): Promise<ExperienceOccurrenceReservation> {
  void tx;
  void rule;
  void scheduledFor;
  void nativeRecurringOccurrenceId;
  return { outcome: 'policy_blocked', reason: 'disabled' };
}

async function loadOccurrence(
  tx: Tx | ReturnType<typeof getDatabase>,
  id: string,
) {
  const [row] =
    await tx`select r.*,a.owner_id,a.employee_assignment_id,a.experience_binding,a.status as automation_status,a.deleted_at
    from allrice_automation_runs r join allrice_automations a on a.id=r.automation_id
    where r.id=${UuidSchema.parse(id)} and r.experience_occurrence is not null`;
  if (!row) return deny();
  const occurrence = ExperienceOccurrenceSchema.parse(
    row.experience_occurrence,
  );
  if (
    occurrence.id !== id ||
    occurrence.organizationId !== row.organization_id ||
    occurrence.workspaceId !== row.workspace_id ||
    occurrence.ownerId !== row.owner_id ||
    occurrence.assignmentId !== row.employee_assignment_id ||
    ExperienceAutomationBindingSchema.parse(row.experience_binding)
      .instanceId !== occurrence.instanceId
  )
    return deny();
  return { row, occurrence };
}

async function assertCurrent(
  tx: Tx,
  occurrence: ExperienceOccurrence,
  executing = true,
  options: { sourceIds?: string[]; checkSkills?: boolean } = {},
  /** `false` on read paths: same checks as plain snapshot reads. */
  lock = true,
) {
  if (!experienceReviewEnabled()) throw new ExperienceError('disabled');
  // Existing source reads use executing=false; only old execution is closed.
  if (executing) throw new ExperienceError('disabled');
  const who = identity(occurrence);
  // Match personal-Skill mutation order and retain the shared content lock
  // through receipt commit, so a concurrent revocation cannot slip past pins.
  if (!(await readContentPrincipal(who, tx, lock))) return deny();
  if (lock)
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`employee-content:${occurrence.organizationId}`},0))`;
  const current = await resolveEmployeeSessionInstance(
    who,
    occurrence.assignmentId,
    occurrence.instanceId,
    tx,
    lock,
  );
  if (executing && stableInstance(current) !== occurrence.instanceDigest)
    return deny();
  if (
    executing &&
    runtimePolicyDigest(await currentRules(tx, occurrence, current)) !==
      runtimePolicyDigest(occurrence.currentRules)
  )
    return deny();
  const sources = options.sourceIds
    ? occurrence.sources.filter((s) => options.sourceIds!.includes(s.id))
    : occurrence.sources;
  if (options.sourceIds && sources.length !== options.sourceIds.length)
    return deny();
  for (const source of [...sources].sort((a, b) => a.id.localeCompare(b.id))) {
    const [row] =
      await tx`select e.source_excerpt,e.source_digest,e.evidence,m.lifecycle_state,m.archived_at,
      msg.content->>'text' original_text from allrice_experience_reviews e
      join allrice_memories m on m.id=e.memory_id and m.owner_id=e.owner_id
      join allrice_chat_sessions s on s.id=e.session_id and s.owner_id=e.owner_id and s.archived_at is null
      join allrice_messages msg on msg.id=e.message_id and msg.session_id=s.id and msg.owner_id=e.owner_id and msg.role='user'
      where e.memory_id=${source.id} and e.organization_id=${occurrence.organizationId} and e.workspace_id=${occurrence.workspaceId}
        and e.owner_id=${occurrence.ownerId} and e.instance_id=${occurrence.instanceId} and e.status='pending'
        and e.consolidation_occurrence_id=${occurrence.id} and e.run_id=${source.runId} and e.message_id=${source.messageId}
        and e.session_id=${source.sessionId} ${lock ? tx`for share of e,m,s,msg` : tx``}`;
    if (
      !row ||
      row.archived_at ||
      row.lifecycle_state !== 'candidate' ||
      row.source_excerpt !== source.excerpt ||
      row.source_digest !== source.sourceDigest ||
      runtimePolicyDigest(row.evidence) !==
        runtimePolicyDigest(source.evidence) ||
      `sha256:${createHash('sha256').update(row.original_text).digest('hex')}` !==
        source.sourceDigest
    )
      return deny();
    // Evidence may contain two Runs with different versions of up to 8 Skills.
    // Check each historical pin instead of treating all 16 as one Run snapshot.
    for (const evidence of options.checkSkills === false
      ? []
      : source.evidence.skills) {
      const index = {
        schemaVersion: 1 as const,
        instanceId: occurrence.instanceId,
        skills: [evidence.pin],
      };
      await assertPersonalSkillsReadable(
        who,
        { ...index, checksum: runtimePolicyDigest(index) },
        tx,
      );
    }
  }
}

/** Fixed-draft validation does not rewrite the original collection policy or
 * receipt. Recheck original sources and rule dependencies under their locks. */
export async function readExperienceValidationSource(
  tx: Tx,
  id: string,
  draftIndex?: number,
  lock = true,
) {
  const { row, occurrence } = await loadOccurrence(tx, id);
  if (!row.experience_receipt) return deny();
  const receipt = ExperienceReceiptSchema.parse(row.experience_receipt);
  const draft =
    draftIndex === undefined ? undefined : receipt.output.drafts[draftIndex];
  if (draftIndex !== undefined && !draft) return deny();
  // Planning reads provenance only. Executing/consuming a draft must pass its
  // index so an unrelated Skill's revocation cannot disable this draft.
  await assertCurrent(
    tx,
    occurrence,
    false,
    draft ? { sourceIds: draft.sourceIds } : { checkSkills: false },
    lock,
  );
  const current = await resolveEmployeeSessionInstance(
    identity(occurrence),
    occurrence.assignmentId,
    occurrence.instanceId,
    tx,
    lock,
  );
  if (
    stableInstance(current) !== occurrence.instanceDigest ||
    runtimePolicyDigest(await currentRules(tx, occurrence, current, lock)) !==
      runtimePolicyDigest(occurrence.currentRules) ||
    row.status !== 'succeeded' ||
    !row.experience_receipt
  )
    return deny();
  const execution = ExperienceExecutionSchema.parse(row.experience_execution);
  if (
    receipt.runId !== row.run_id ||
    receipt.occurrenceDigest !== runtimePolicyDigest(occurrence) ||
    receipt.executionDigest !== runtimePolicyDigest(execution) ||
    receipt.outputDigest !== runtimePolicyDigest(receipt.output)
  )
    return deny();
  return { occurrence, receipt, execution };
}

export async function experienceOccurrencePrincipal(
  id: string,
): Promise<ResourcePrincipal> {
  void id;
  throw new ExperienceError('disabled');
}

export async function prepareExperienceExecution(
  id: string,
): Promise<z.infer<typeof ExperienceExecutionSchema>> {
  void id;
  throw new ExperienceError('disabled');
}

export async function bindExperienceRun(
  tx: Tx,
  id: string,
  runId: string,
  ownerId: string,
) {
  void tx;
  void id;
  void runId;
  void ownerId;
  throw new ExperienceError('disabled');
}

export async function getExperienceExecution(runId: string) {
  return getDatabase().begin((tx) =>
    getExperienceExecutionInTransaction(tx, runId),
  );
}

/** Existing queue/native gates translate the disabled business authority
 * through their existing failure contracts, before any new model execution. */
export async function getExperienceExecutionInTransaction(
  tx: Tx,
  runId: string,
): Promise<{
  occurrence: ExperienceOccurrence;
  execution: z.infer<typeof ExperienceExecutionSchema>;
}> {
  void tx;
  void runId;
  throw new ExperienceError('disabled');
}

/** Refuse late business output. The Worker already settles model usage in
 * its route transaction; the ordinary Job failure path retains that ledger. */
export async function completeExperienceConsolidation(
  tx: Tx,
  job: {
    run_id: string;
    id: string;
    owner_id: string;
    timeout_at: Date;
    lease_expires_at: Date | null;
  },
  raw: unknown,
): Promise<{
  occurrenceId: string;
  state: 'pending_validation';
  draftCount: number;
}> {
  void tx;
  void job;
  void raw;
  throw new ExperienceError('disabled');
}

export async function recoverExperienceOccurrences(
  limit = 4,
): Promise<string[]> {
  void limit;
  return [];
}

export async function dispatchExperienceOccurrence(id: string) {
  const { enqueueExperienceConsolidationRun } =
    await import('./execution/queue.ts');
  try {
    await prepareExperienceExecution(id);
    await enqueueExperienceConsolidationRun(id);
  } catch (error) {
    // Unknown enqueue result is read back. A bound/paid Run is never replayed.
    const db = getDatabase(),
      { row } = await loadOccurrence(db, id);
    if (row.run_id) return;
    await db`update allrice_automation_runs set status='failed',completed_at=clock_timestamp(),error_code='EXPERIENCE_PREPARATION_FAILED',
      error_message='整理未启动；来源已保留，请核查配置或权限。' where id=${id} and run_id is null and status='queued'`;
    throw error;
  }
}

export async function listExperienceDrafts(
  context: RequestContext,
  instanceId?: string,
) {
  if (!experienceReviewEnabled()) throw new ExperienceError('disabled');
  if (instanceId) UuidSchema.parse(instanceId);
  return getDatabase().begin(async (tx) => {
    if (
      !(await readContentPrincipal(context, tx)) ||
      context.actor.type !== 'user'
    )
      throw new ExperienceError('identity_denied');
    const rows =
      await tx`select r.id,r.run_id,r.status,r.created_at,r.error_code,r.experience_occurrence,r.experience_receipt,r.experience_validation_plan
      from allrice_automation_runs r join allrice_automations a on a.id=r.automation_id
      where r.organization_id=${context.organizationId} and r.workspace_id=${context.workspaceId!} and a.owner_id=${context.actor.id}
        and r.experience_occurrence is not null and (${instanceId ?? null}::uuid is null or r.experience_occurrence->>'instanceId'=${instanceId ?? null})
      order by r.created_at desc,r.id desc limit 50`;
    const result = [];
    for (const row of rows) {
      const occurrence = ExperienceOccurrenceSchema.parse(
        row.experience_occurrence,
      );
      // Historical reading does not grant current execution or adoption.
      await getEmployeeInstanceForHistory(context, occurrence.instanceId, tx);
      let sourceState: 'current' | 'unavailable' = 'current';
      try {
        await assertCurrent(
          tx,
          occurrence,
          false,
          {
            checkSkills: !row.experience_receipt,
          },
          false,
        );
      } catch (error) {
        if (
          error instanceof ExperienceError ||
          error instanceof DataAccessError ||
          error instanceof EmployeeInstanceError ||
          error instanceof PersonalSkillError
        )
          sourceState = 'unavailable';
        else throw error;
      }
      const receipt = row.experience_receipt
        ? ExperienceReceiptSchema.parse(row.experience_receipt)
        : null;
      const { listExperienceValidationViews } =
        await import('./experience-validation.ts');
      const { listExperienceAdoptionViews } =
        await import('./experience-adoption.ts');
      const validations = await listExperienceValidationViews(
        tx,
        occurrence.id,
      );
      result.push({
        adoptions: await listExperienceAdoptionViews(
          tx,
          identity(occurrence),
          occurrence.id,
        ),
        id: row.id,
        runId: row.run_id,
        instanceId: occurrence.instanceId,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        errorCode: row.error_code,
        state: receipt?.state ?? 'not_ready',
        revision: receipt?.revision ?? null,
        digest: receipt?.outputDigest ?? null,
        sourceIds: occurrence.sources.map((s) => s.id),
        sourceState,
        skillDependencies: [
          ...new Map(
            occurrence.sources
              .flatMap((s) => s.evidence.skills)
              .map((s) => [runtimePolicyDigest(s.pin), s.pin]),
          ).values(),
        ],
        drafts: receipt?.output.drafts ?? [],
        validations,
        validationNotes: Array.isArray(row.experience_validation_plan)
          ? row.experience_validation_plan
              // The immutable original plan remains audit evidence. Once a
              // continuation has a real test, render its current result rather
              // than a contradictory historical "not covered" notice.
              .filter(
                (p: { draftIndex?: number; reason?: string }) =>
                  p.reason &&
                  !validations.some((v) => v.draftIndex === p.draftIndex),
              )
              .map((p: { reason: string }) => p.reason)
          : [],
      });
    }
    return result;
  });
}
