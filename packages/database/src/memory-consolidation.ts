import { randomUUID, createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  UuidSchema,
  MemorySourceEvidenceSchema,
  validateMemoryDraftOutput,
  experiencePolicySchedule,
  type Membership,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { ExperienceError, experienceReviewEnabled } from './experience.ts';
import { DataAccessError } from './data.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  resolveEmployeeSessionInstance,
  EmployeeInstanceError,
} from './employees/employee-instances.ts';
import { assertPersonalSkillsReadable } from './employees/personal-skills.ts';
import {
  freezeEmployeeBaseSkills,
  assertFrozenBaseSkillCatalog,
} from './employees/employee-base-skills.ts';
import { freezeExperienceModelSnapshot } from './providers/model-pool.ts';
import { nextScheduleAt } from './execution/automation.ts';
import { newCurrentInternalNativeRootOrigin } from './conversation/native-root-origin.ts';
import type { ResourcePrincipal } from './resource-principal.ts';
import {
  readExperiencePolicy,
  readExperienceCurrentRules,
  experienceInstanceDigest as stableInstance,
  type ExperienceScheduleRule,
  type ExperienceOccurrenceReservation,
} from './experience-consolidation.ts';
import {
  ExperienceAutomationBindingSchema,
  experienceConsolidationLimits as limits,
} from './experience-consolidation-contracts.ts';
import {
  MemoryOccurrenceSchema,
  MemoryExecutionSchema,
  MemoryReceiptSchema,
  assertMemoryBatchBounds,
  type MemoryOccurrence,
} from './memory-consolidation-contracts.ts';
import { employeeMemoryReadPredicate } from './workspace/employee-memory-read.ts';
import { readEmployeeRunSourceKind } from './employees/employee-chat-authority.ts';
import { loadedExperienceSkillEvidence } from './experience-evidence.ts';

type Tx = postgres.TransactionSql;
type Rule = ExperienceScheduleRule;
const deny = (): never => {
  throw new ExperienceError('source_changed');
};
const identity = (
  o: Pick<MemoryOccurrence, 'organizationId' | 'workspaceId' | 'ownerId'>,
) => ({
  actor: { type: 'user' as const, id: o.ownerId },
  organizationId: o.organizationId,
  workspaceId: o.workspaceId,
});
/** Recheck the original human execution, not just the private review row. */
async function assertSourceDependencies(
  tx: Tx,
  o: MemoryOccurrence,
  source: MemoryOccurrence['sources'][number],
) {
  const e = source.evidence;
  if (
    e.truncated ||
    e.runId !== source.runId ||
    e.messageId !== source.messageId ||
    e.kind !==
      (e.captureRunId === e.runId ? 'human_message' : 'adopted_steering')
  )
    return deny();
  const [actual] = await tx<
    { run_id: string; user_message_id: string; execution_snapshot: unknown }[]
  >`
    select actual.run_id,actual.user_message_id,actual.execution_snapshot from allrice_employee_runs er
    join allrice_employee_runs actual on actual.run_id=coalesce(er.experience_execution_run_id,er.run_id)
      and actual.organization_id=er.organization_id and actual.workspace_id=er.workspace_id
      and actual.owner_id=er.owner_id and actual.session_id=er.session_id
      and actual.employee_assignment_id=er.employee_assignment_id
    join allrice_messages msg on msg.id=er.user_message_id and msg.session_id=er.session_id
      and msg.organization_id=er.organization_id and msg.workspace_id=er.workspace_id and msg.owner_id=er.owner_id
    where er.run_id=${e.captureRunId} and actual.run_id=${source.runId}
      and er.user_message_id=${source.messageId} and er.session_id=${source.sessionId}
      and er.organization_id=${o.organizationId} and er.workspace_id=${o.workspaceId} and er.owner_id=${o.ownerId}
      and er.employee_assignment_id=${o.assignmentId} and not er.method_authoring and not actual.method_authoring
      and er.execution_snapshot->'instance'->>'id'=${o.instanceId}
      and actual.execution_snapshot->'instance'->>'id'=${o.instanceId}
      and er.status in ('succeeded','failed','canceled') and er.completed_at is not null
      and actual.status in ('succeeded','failed','canceled') and actual.completed_at is not null
      and msg.role='user' and msg.status='completed' and msg.created_at>=${e.collectionStartedAt}::timestamptz
      and not exists(select 1 from allrice_runtime_run_links l where l.run_id in (er.run_id,actual.run_id) and l.root_run_id<>l.run_id)
      and (er.experience_execution_run_id is null or exists(
        select 1 from allrice_conversation_commands c where c.followup_run_id=er.run_id
          and c.organization_id=er.organization_id and c.workspace_id=er.workspace_id and c.session_id=er.session_id
          and c.owner_id=er.owner_id and c.client_user_message_id=msg.client_message_id
          and c.state='consumed' and c.input_kind='steer_current'
          and c.native_proof->>'status'='adopted' and c.native_proof->>'inputId'=c.client_user_message_id::text
          and ((c.native_proof->>'runId' is not null and c.native_proof->>'runId'=actual.run_id::text)
            or (c.native_proof->>'runId' is null and c.native_proof->>'turnId'=c.expected_turn_id))))
    for share of er,actual,msg`;
  if (!actual) return deny();
  for (const [runId, userMessageId] of [
    [e.captureRunId, source.messageId],
    [source.runId, actual.user_message_id],
  ]) {
    if (
      (await readEmployeeRunSourceKind(
        {
          runId: runId!,
          userMessageId: userMessageId!,
          organizationId: o.organizationId,
          workspaceId: o.workspaceId,
          ownerId: o.ownerId,
        },
        tx,
      )) !== 'human'
    )
      return deny();
  }
  const events = await tx<
    { id: string; run_id: string; event_type: string; payload: unknown }[]
  >`
    select id,run_id,event_type,payload from allrice_run_events where run_id=${source.runId}
      and organization_id=${o.organizationId} and workspace_id=${o.workspaceId}
      and event_type='tool.completed' and payload->>'name'='skill' and payload->'nativePayload'->>'skillStatus'='loaded'
    order by sequence limit 65`;
  if (
    runtimePolicyDigest(loadedExperienceSkillEvidence(actual, events)) !==
    runtimePolicyDigest(e.skills)
  )
    return deny();
  const inputs = await tx<
    {
      message_id: string;
      object_id: string;
      checksum: string;
      owner_id: string;
      attached_by: string;
      state: string;
      deleted_at: Date | null;
      retention_until: Date | null;
    }[]
  >`
    select a.message_id,o.id object_id,o.checksum,o.owner_id,a.attached_by,o.state,o.deleted_at,o.retention_until
    from allrice_message_attachments a join allrice_storage_objects o on o.id=a.object_id
      and o.organization_id=a.organization_id and o.workspace_id=a.workspace_id
    where a.message_id in ${tx([...new Set([source.messageId, actual.user_message_id])])}
      and a.organization_id=${o.organizationId} and a.workspace_id=${o.workspaceId}
    order by a.message_id,a.object_id for share of a,o`;
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
  if (
    inputs.some(
      (f) =>
        f.owner_id !== o.ownerId ||
        f.attached_by !== o.ownerId ||
        f.state !== 'ready' ||
        f.deleted_at ||
        (f.retention_until && f.retention_until <= clock!.now),
    ) ||
    runtimePolicyDigest(
      inputs.map((f) => ({
        messageId: f.message_id,
        objectId: f.object_id,
        checksum: f.checksum,
      })),
    ) !== runtimePolicyDigest(e.inputs)
  )
    return deny();
  // Artifacts and availableKnowledge are provenance identities, not new facts:
  // their bodies are never sent to the model or converted to sourceIds.
}
async function currentRules(
  tx: Tx,
  owner: Parameters<typeof readExperienceCurrentRules>[1],
  instance: Parameters<typeof readExperienceCurrentRules>[2],
) {
  // Reuse M3's current eligibility, not a second memory authority or model input path.
  const scope = { ...owner, instanceId: instance.id };
  const confirmedMemories = await tx<
    { id: string; revision: number; content: string }[]
  >`
    select m.id,m.revision,m.content from allrice_memories m
    where ${employeeMemoryReadPredicate(tx, scope)} order by m.id for share of m`;
  return {
    ...(await readExperienceCurrentRules(tx, owner, instance)),
    confirmedMemories: [...confirmedMemories],
  };
}
export async function syncExperienceConsolidationSchedules() {
  const { experienceNativeCalendarEnabled } =
    await import('./experience-native.ts');
  if (!experienceNativeCalendarEnabled()) return 0;
  const db = getDatabase();
  const instances = await db<
    {
      organization_id: string;
      workspace_id: string;
      owner_id: string;
      instance_id: string;
      assignment_id: string;
    }[]
  >`
    select distinct e.organization_id,e.workspace_id,e.owner_id,e.instance_id,i.assignment_id
    from allrice_experience_reviews e join allrice_memories m on m.id=e.memory_id and m.archived_at is null
    join allrice_employee_instances i on i.id=e.instance_id and i.archived_at is null
    join allrice_users u on u.id=e.owner_id and u.status='active'
    join allrice_organizations o on o.id=e.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=e.workspace_id and w.organization_id=e.organization_id and w.archived_at is null
    join allrice_employee_assignments x on x.id=i.assignment_id and x.user_id=e.owner_id and x.active
    join allrice_employees employee on employee.id=x.employee_id and employee.status='active'
    left join allrice_settings policy on policy.scope_type='organization' and policy.scope_id=e.organization_id and policy.key='employee_experience_policy'
    left join allrice_settings default_policy on default_policy.scope_type='system' and default_policy.scope_id is null and default_policy.key='employee_experience_policy'
    where coalesce(policy.value,default_policy.value)->>'frequency'<>'off'
      and exists(select 1 from allrice_memberships membership where membership.organization_id=e.organization_id and membership.user_id=e.owner_id
        and membership.active and membership.role in ('member','admin') and (membership.workspace_id is null or membership.workspace_id=e.workspace_id))
      and not exists(select 1 from allrice_platform_employee_tenant_assignments d where d.organization_id=x.organization_id and d.workspace_id=x.workspace_id and d.tenant_employee_id=x.employee_id and not d.active)
      and e.evidence->>'schemaVersion'='2' and e.origin_kind='incremental' and e.status='pending' and e.consolidation_occurrence_id is null
      and not exists(select 1 from allrice_automations a where a.organization_id=e.organization_id and a.workspace_id=e.workspace_id
        and a.owner_id=e.owner_id and a.experience_binding->>'instanceId'=e.instance_id::text and a.deleted_at is null)
    order by e.organization_id,e.workspace_id,e.owner_id,e.instance_id,i.assignment_id limit 64`;
  let count = 0;
  for (const i of instances) {
    try {
      await db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`experience-policy:${i.organization_id}`},183))`;
        const policy = await readExperiencePolicy(i.organization_id, tx);
        if (policy.frequency === 'off') return;
        await resolveEmployeeSessionInstance(
          identity({
            organizationId: i.organization_id,
            workspaceId: i.workspace_id,
            ownerId: i.owner_id,
          }),
          i.assignment_id,
          i.instance_id,
          tx,
        );
        const schedule = experiencePolicySchedule(policy);
        const inserted =
          await tx`insert into allrice_automations(organization_id,workspace_id,owner_id,name,description,prompt,
          trigger_type,schedule,status,conversation_mode,employee_assignment_id,next_run_at,experience_binding)
          values(${i.organization_id},${i.workspace_id},${i.owner_id},'AI 员工经验整理','私有增量反馈整理；草稿尚未生效',
            '仅整理已授权的私有反馈证据','schedule',${tx.json(schedule)},'enabled','new_each_run',${i.assignment_id},${nextScheduleAt(schedule)},
            ${tx.json({ schemaVersion: 1, instanceId: i.instance_id, policyDigest: runtimePolicyDigest(policy) })})
          on conflict do nothing returning id`;
        count += inserted.length;
      });
    } catch (error) {
      if (!(
        error instanceof DataAccessError ||
        error instanceof EmployeeInstanceError
      ))
        throw error;
    }
  }
  return count;
}

export async function reserveExperienceOccurrenceInTransaction(
  tx: Tx,
  rule: Rule,
  scheduledFor: Date,
  nativeRecurringOccurrenceId: string | null = null,
): Promise<ExperienceOccurrenceReservation> {
  if (!experienceReviewEnabled())
    return { outcome: 'policy_blocked', reason: 'disabled' };
  const binding = ExperienceAutomationBindingSchema.parse(
    rule.experience_binding,
  );
  async function existing() {
    const [row] = await tx<
      {
        id: string;
        organization_id: string;
        workspace_id: string;
        experience_occurrence: unknown;
      }[]
    >`
      select id,organization_id,workspace_id,experience_occurrence from allrice_automation_runs
      where automation_id=${rule.id} and scheduled_for=${scheduledFor} and folder_event_id is null for share`;
    if (!row) return null;
    const parsed = MemoryOccurrenceSchema.safeParse(row.experience_occurrence);
    if (!parsed.success) throw new ExperienceError('disabled');
    const occurrence = parsed.data;
    if (
      row.organization_id !== rule.organization_id ||
      row.workspace_id !== rule.workspace_id ||
      occurrence.ownerId !== rule.owner_id ||
      occurrence.assignmentId !== rule.employee_assignment_id ||
      occurrence.instanceId !== binding.instanceId ||
      occurrence.id !== row.id
    )
      return deny();
    return row.id;
  }
  const prior = await existing();
  if (prior) return { outcome: 'already_claimed', automationRunId: prior };
  const policy = await readExperiencePolicy(rule.organization_id, tx);
  if (
    policy.frequency === 'off' ||
    runtimePolicyDigest(policy) !== binding.policyDigest
  ) {
    await tx`update allrice_automations set status='paused',next_run_at=null where id=${rule.id}`;
    return { outcome: 'policy_blocked', reason: 'policy_changed' };
  }
  await tx`select pg_advisory_xact_lock(hashtext('experience-consolidation-daily-budget'))`;
  const [budget] = await tx<
    { global_count: number; org_count: number; instance_count: number }[]
  >`
    select count(*)::int global_count,count(*) filter(where organization_id=${rule.organization_id})::int org_count,
      count(*) filter(where experience_occurrence->>'instanceId'=${binding.instanceId})::int instance_count
    from allrice_automation_runs where experience_occurrence is not null
      and jsonb_array_length(experience_occurrence->'sources')>0 and created_at>clock_timestamp()-interval '24 hours'`;
  if (
    budget!.global_count >= limits.globalDailyRuns ||
    budget!.org_count >= limits.organizationDailyRuns ||
    budget!.instance_count >= 1
  )
    return {
      outcome: 'budget',
      budget: {
        globalCount: budget!.global_count,
        organizationCount: budget!.org_count,
        instanceCount: budget!.instance_count,
      },
    };
  const owner = {
    organizationId: rule.organization_id,
    workspaceId: rule.workspace_id,
    ownerId: rule.owner_id,
  };
  const instance = await resolveEmployeeSessionInstance(
    identity(owner),
    rule.employee_assignment_id!,
    binding.instanceId,
    tx,
  );
  const rows = await tx<
    {
      memory_id: string;
      run_id: string;
      session_id: string;
      message_id: string;
      source_excerpt: string;
      source_digest: string;
      evidence: unknown;
    }[]
  >`
    select e.memory_id,e.run_id,e.session_id,e.message_id,e.source_excerpt,e.source_digest,e.evidence
    from allrice_experience_reviews e join allrice_memories m on m.id=e.memory_id
    join allrice_chat_sessions s on s.id=e.session_id and s.owner_id=e.owner_id and s.archived_at is null
    where e.organization_id=${rule.organization_id} and e.workspace_id=${rule.workspace_id} and e.owner_id=${rule.owner_id}
      and e.evidence->>'schemaVersion'='2' and e.instance_id=${binding.instanceId} and e.origin_kind='incremental' and e.status='pending'
      and e.consolidation_occurrence_id is null and m.archived_at is null and m.lifecycle_state='candidate'
    order by e.created_at,e.memory_id for update of e,m skip locked limit ${limits.sources}`;
  let characters = 0;
  const sources = rows
    .filter((r) => {
      characters += r.source_excerpt.length;
      return characters <= limits.sourceCharacters;
    })
    .map((r) => ({
      id: r.memory_id,
      runId: r.run_id,
      sessionId: r.session_id,
      messageId: r.message_id,
      excerpt: r.source_excerpt,
      sourceDigest: r.source_digest,
      evidence: MemorySourceEvidenceSchema.parse(r.evidence),
    }));
  const [assignment] = await tx<
    { employee_id: string }[]
  >`select employee_id from allrice_employee_assignments where id=${instance.assignmentId}`;
  if (!assignment) return deny();
  await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`employee-content:${owner.organizationId}`},0))`;
  const occurrence = MemoryOccurrenceSchema.parse({
    schemaVersion: 2,
    id: randomUUID(),
    ...owner,
    assignmentId: instance.assignmentId,
    instanceId: instance.id,
    employeeId: assignment.employee_id,
    employeeVersionId: instance.source.employeeVersionId,
    instanceDigest: stableInstance(instance),
    currentRules: await currentRules(
      tx,
      { ...owner, employeeId: assignment.employee_id },
      instance,
    ),
    policy,
    policyDigest: runtimePolicyDigest(policy),
    createdAt: new Date().toISOString(),
    sources,
  });
  const origin = sources.length
    ? newCurrentInternalNativeRootOrigin(
        'experience_consolidation',
        occurrence.id,
        {
          recipe: 'allrice-experience-consolidation/v1',
          occurrence,
        },
      )
    : null;
  const [written] =
    await tx`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,scheduled_for,status,
    experience_occurrence,completed_at,error_code,native_root_origin,native_recurring_occurrence_id) values(${occurrence.id},${rule.organization_id},${rule.workspace_id},${rule.id},
      ${scheduledFor},${sources.length ? 'queued' : 'succeeded'},${tx.json(occurrence)},${sources.length ? null : new Date()},${sources.length ? null : 'EXPERIENCE_NO_NEW_EVIDENCE'},${origin ? tx.json(origin) : null},${nativeRecurringOccurrenceId})
    on conflict(automation_id,scheduled_for) where folder_event_id is null and manual_request_id is null do nothing returning id`;
  if (!written) {
    const exact = await existing();
    if (!exact) return deny();
    return { outcome: 'already_claimed', automationRunId: exact };
  }
  if (!sources.length)
    return { outcome: 'empty', automationRunId: occurrence.id }; // No job, route, native runtime or model charge.
  await tx`update allrice_experience_reviews set consolidation_occurrence_id=${occurrence.id}
    where memory_id in ${tx(sources.map((s) => s.id))} and consolidation_occurrence_id is null`;
  return { outcome: 'queued', automationRunId: occurrence.id };
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
  const parsed = MemoryOccurrenceSchema.safeParse(row.experience_occurrence);
  if (!parsed.success) throw new ExperienceError('disabled');
  const occurrence = parsed.data;
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
  occurrence: MemoryOccurrence,
  executing = true,
  options: { sourceIds?: string[]; checkSkills?: boolean } = {},
  /** `false` on read paths: same checks as plain snapshot reads. */
  lock = true,
) {
  if (!experienceReviewEnabled()) throw new ExperienceError('disabled');
  if (executing) {
    const policy = await readExperiencePolicy(occurrence.organizationId, tx);
    if (
      policy.frequency === 'off' ||
      runtimePolicyDigest(policy) !== occurrence.policyDigest
    )
      return deny();
  }
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
      join allrice_messages msg on msg.id=e.message_id and msg.session_id=s.id and msg.owner_id=e.owner_id and msg.role='user' and msg.status='completed'
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
    await assertSourceDependencies(tx, occurrence, source);
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

export async function experienceOccurrencePrincipal(
  id: string,
): Promise<ResourcePrincipal> {
  return getDatabase().begin(async (tx) => {
    const { occurrence, row } = await loadOccurrence(tx, id);
    if (
      row.deleted_at ||
      row.automation_status !== 'enabled' ||
      !occurrence.sources.length
    )
      return deny();
    assertMemoryBatchBounds(occurrence);
    await assertCurrent(tx, occurrence);
    const rows = await tx<
      { id: string; role: Membership['role']; workspace_id: string | null }[]
    >`
      select id,role,workspace_id from allrice_memberships where user_id=${occurrence.ownerId} and organization_id=${occurrence.organizationId}
        and active and role in ('member','admin') and (workspace_id is null or workspace_id=${occurrence.workspaceId})`;
    return {
      requestId: occurrence.id,
      ...identity(occurrence),
      memberships: rows.map((r) => ({
        id: r.id,
        userId: occurrence.ownerId,
        organizationId: occurrence.organizationId,
        workspaceId: r.workspace_id,
        role: r.role,
        active: true,
      })),
    };
  });
}

export async function prepareExperienceExecution(id: string) {
  await experienceOccurrencePrincipal(id);
  const db = getDatabase(),
    { row, occurrence } = await loadOccurrence(db, id);
  assertMemoryBatchBounds(occurrence);
  if (row.experience_execution)
    return MemoryExecutionSchema.parse(row.experience_execution);
  const base = await freezeEmployeeBaseSkills([]);
  const skill = base.nativeSkills.find(
    (s) => s.name === 'experience-consolidation',
  );
  const entry = base.catalog?.skills.find((s) => s.id === skill?.id);
  if (!skill || !entry || !base.catalog)
    throw Error('EXPERIENCE_SKILL_UNAVAILABLE');
  const nativeSkills = [skill],
    skills = [entry];
  const catalog = {
    ...base.catalog,
    skills,
    snapshotChecksum: runtimePolicyDigest({ skills, nativeSkills }),
  };
  const model = await freezeExperienceModelSnapshot({
    ...occurrence,
    occurrenceId: occurrence.id,
  });
  const execution = MemoryExecutionSchema.parse({
    schemaVersion: 2,
    occurrenceDigest: runtimePolicyDigest(occurrence),
    model,
    nativeSkills,
    catalog,
  });
  await db`update allrice_automation_runs set experience_execution=${db.json(execution)} where id=${id}
    and experience_execution is null and run_id is null and status='queued'`;
  return MemoryExecutionSchema.parse(
    (await loadOccurrence(db, id)).row.experience_execution,
  );
}

export async function bindExperienceRun(
  tx: Tx,
  id: string,
  runId: string,
  ownerId: string,
) {
  const { row, occurrence } = await loadOccurrence(tx, id);
  assertMemoryBatchBounds(occurrence);
  await assertCurrent(tx, occurrence);
  if (
    ownerId !== occurrence.ownerId ||
    row.status !== 'queued' ||
    row.deleted_at ||
    row.automation_status !== 'enabled' ||
    (row.run_id && row.run_id !== runId)
  )
    return deny();
  const execution = MemoryExecutionSchema.parse(row.experience_execution);
  if (
    execution.model.occurrenceId !== id ||
    execution.occurrenceDigest !== runtimePolicyDigest(occurrence)
  )
    return deny();
  await tx`update allrice_automation_runs set run_id=${runId} where id=${id} and run_id is null`;
}

export async function getExperienceExecution(runId: string) {
  return getDatabase().begin((tx) =>
    getExperienceExecutionInTransaction(tx, runId),
  );
}

/** Preserves the full source/policy/Skill authority check in the caller's
 * existing Job transaction, without acquiring a second connection or lock183. */
export async function getExperienceExecutionInTransaction(
  tx: Tx,
  runId: string,
) {
  const [r] =
    await tx`select id from allrice_automation_runs where run_id=${runId} and experience_occurrence is not null`;
  if (!r) return deny();
  const { row, occurrence } = await loadOccurrence(tx, r.id);
  if (row.deleted_at || row.automation_status !== 'enabled') return deny();
  assertMemoryBatchBounds(occurrence);
  await assertCurrent(tx, occurrence);
  const execution = MemoryExecutionSchema.parse(row.experience_execution);
  assertFrozenBaseSkillCatalog(execution.catalog, execution.nativeSkills);
  if (
    execution.model.occurrenceId !== occurrence.id ||
    execution.model.employeeId !== occurrence.employeeId ||
    execution.occurrenceDigest !== runtimePolicyDigest(occurrence)
  )
    return deny();
  return { occurrence, execution };
}

/** completeJob owns the lease lock and commits receipt + source progress atomically. */
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
) {
  const [r] =
    await tx`select id from allrice_automation_runs where run_id=${job.run_id} and experience_occurrence is not null for update`;
  if (!r || job.timeout_at <= new Date()) return deny();
  const { row, occurrence } = await loadOccurrence(tx, r.id);
  if (
    row.deleted_at ||
    row.automation_status !== 'enabled' ||
    occurrence.ownerId !== job.owner_id
  )
    return deny();
  assertMemoryBatchBounds(occurrence);
  await assertCurrent(tx, occurrence);
  const execution = MemoryExecutionSchema.parse(row.experience_execution);
  const output = validateMemoryDraftOutput(
    raw,
    occurrence.sources.map((s) => s.id),
  );
  const skill = execution.nativeSkills[0]!,
    pin = execution.catalog.skills[0]!;
  const [load] =
    await tx`select id from allrice_run_events where run_id=${job.run_id} and event_type='tool.completed'
    and payload->>'name'='skill' and payload->'nativePayload'->>'skillStatus'='loaded'
    and payload->'nativePayload'->>'skillId'=${skill.id} and payload->'nativePayload'->>'skillChecksum'=${skill.checksum}
    and payload->'nativePayload'->>'skillVersion'=${pin.version}
    and payload->'nativePayload'->>'skillCatalogChecksum'=${execution.catalog.catalogChecksum}
    and payload->'internalTask'->>'occurrenceId'=${occurrence.id} order by sequence limit 1`;
  const [accounted] =
    await tx`select d.id from allrice_route_decisions d join allrice_model_usage_ledger l on l.route_decision_id=d.id
    where d.run_id=${job.run_id} and d.status='succeeded'`;
  if (!load || !accounted) throw Error('EXPERIENCE_EXECUTION_PROOF_REQUIRED');
  // Authority checks can wait for concurrent content changes. The job lock
  // prevents heartbeats while we wait: recheck real database time at commit.
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
  if (
    !job.lease_expires_at ||
    job.lease_expires_at <= clock!.now ||
    job.timeout_at <= clock!.now
  ) {
    const { QueueError } = await import('./execution/queue.ts');
    throw new QueueError('lease_lost');
  }
  const receipt = MemoryReceiptSchema.parse({
    schemaVersion: 2,
    occurrenceDigest: runtimePolicyDigest(occurrence),
    executionDigest: runtimePolicyDigest(execution),
    runId: job.run_id,
    output,
    revision: 1,
    outputDigest: runtimePolicyDigest(output),
    skillLoadEventId: load.id,
    createdAt: new Date().toISOString(),
  });
  await tx`update allrice_automation_runs set experience_receipt=${tx.json(receipt)} where id=${occurrence.id} and experience_receipt is null`;
  await tx`update allrice_experience_reviews set consolidated_at=clock_timestamp() where consolidation_occurrence_id=${occurrence.id}`;
  return {
    occurrenceId: occurrence.id,
    draftCount: output.drafts.length,
  };
}

export async function recoverExperienceOccurrences(limit = 4) {
  if (!experienceReviewEnabled()) return [];
  const rows = await getDatabase()<
    { id: string }[]
  >`select id from allrice_automation_runs
    where experience_occurrence->>'schemaVersion'='2' and run_id is null and status='queued' order by created_at,id limit ${Math.min(limit, 16)}`;
  return rows.map((r) => r.id);
}
export async function dispatchExperienceOccurrence(id: string) {
  const db = getDatabase();
  const [selected] =
    await db`select experience_occurrence from allrice_automation_runs where id=${UuidSchema.parse(id)}`;
  if (
    !MemoryOccurrenceSchema.safeParse(selected?.experience_occurrence).success
  )
    return;
  const { enqueueExperienceConsolidationRun } =
    await import('./execution/queue.ts');
  try {
    await prepareExperienceExecution(id);
    await enqueueExperienceConsolidationRun(id);
  } catch (error) {
    // Unknown enqueue result is read back. A bound/paid Run is never replayed.
    const { row } = await loadOccurrence(db, id);
    if (row.run_id) return;
    const code =
      error instanceof Error &&
      ['MEMORY_SOURCE_INPUT_LIMIT', 'MEMORY_CURRENT_RULES_LIMIT'].includes(
        error.message,
      )
        ? error.message
        : 'EXPERIENCE_PREPARATION_FAILED';
    await db`update allrice_automation_runs set status='failed',completed_at=clock_timestamp(),error_code=${code},
      error_message='整理未启动；来源已保留，请核查配置或权限。' where id=${id} and run_id is null and status='queued'`;
    throw error;
  }
}
