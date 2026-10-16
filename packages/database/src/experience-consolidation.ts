import { randomUUID, createHash } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import {
  ExperienceCollectionPolicySchema,
  ExperiencePolicySettingsSchema,
  ExperienceEvidenceSchema,
  experiencePolicySchedule,
  validateExperienceDraftOutput,
  UuidSchema,
  PlatformEmployeeDefinitionSchema,
  type EmployeeInstance,
  type RequestContext,
  type Membership,
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
} from './employees/employee-instances.ts';
import { freezeEmployeeRuntimeContent } from './employees/employee-content.ts';
import { resolveEmployeeContentSource } from './employees/employee-content-sources.ts';
import {
  assertPersonalSkillsReadable,
  PersonalSkillError,
} from './employees/personal-skills.ts';
import {
  freezeEmployeeBaseSkills,
  assertFrozenBaseSkillCatalog,
} from './employees/employee-base-skills.ts';
import { freezeExperienceModelSnapshot } from './providers/model-pool.ts';
import { nextScheduleAt } from './execution/automation.ts';
import type { ResourcePrincipal } from './resource-principal.ts';
import {
  ExperienceAutomationBindingSchema,
  ExperienceOccurrenceSchema,
  ExperienceExecutionSchema,
  ExperienceReceiptSchema,
  experienceConsolidationLimits as limits,
  type ExperienceOccurrence,
} from './experience-consolidation-contracts.ts';

type Tx = postgres.TransactionSql;
type Rule = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  employee_assignment_id: string | null;
  experience_binding: unknown;
  next_run_at: Date | null;
  schedule: unknown;
};
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
        lock: true,
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
) {
  const rows = await tx<{ scope_type: string; value: unknown }[]>`
    select scope_type,value from allrice_settings where key='employee_experience_policy'
      and ((scope_type='system' and scope_id is null) or (scope_type='organization' and scope_id=${organizationId}))
    order by scope_type for share`;
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
  return readExperiencePolicy(UuidSchema.parse(organizationId));
}
const PolicyUpdateSchema = ExperiencePolicySettingsSchema.extend({
  expectedRevision: z.number().int().positive(),
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
      schemaVersion: 2,
      revision: previous.revision + 1,
    });
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
export async function syncExperienceConsolidationSchedules() {
  if (!experienceReviewEnabled()) return 0;
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
      and e.origin_kind='incremental' and e.status='pending' and e.consolidation_occurrence_id is null
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

/** The Automation row is already locked by its producer. Reserve sources once. */
export async function claimExperienceOccurrence(
  tx: Tx,
  rule: Rule,
  nextRunAt: Date,
) {
  if (!experienceReviewEnabled()) return null;
  const binding = ExperienceAutomationBindingSchema.parse(
    rule.experience_binding,
  );
  const policy = await readExperiencePolicy(rule.organization_id, tx);
  if (
    policy.frequency === 'off' ||
    runtimePolicyDigest(policy) !== binding.policyDigest
  ) {
    await tx`update allrice_automations set status='paused',next_run_at=null where id=${rule.id}`;
    return null;
  }
  await tx`select pg_advisory_xact_lock(hashtext('experience-consolidation-daily-budget'))`;
  const [budget] = await tx<
    { global_count: number; org_count: number; instance_count: number }[]
  >`
    select count(*)::int global_count,count(*) filter(where organization_id=${rule.organization_id})::int org_count,
      count(*) filter(where experience_occurrence->>'instanceId'=${binding.instanceId})::int instance_count
    from allrice_automation_runs where experience_occurrence is not null
      and jsonb_array_length(experience_occurrence->'sources')>0 and created_at>clock_timestamp()-interval '24 hours'`;
  await tx`update allrice_automations set next_run_at=${nextRunAt},last_run_at=clock_timestamp(),updated_at=clock_timestamp() where id=${rule.id}`;
  if (
    budget!.global_count >= limits.globalDailyRuns ||
    budget!.org_count >= limits.organizationDailyRuns ||
    budget!.instance_count >= 1
  )
    return null;
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
      and e.instance_id=${binding.instanceId} and e.origin_kind='incremental' and e.status='pending'
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
      evidence: ExperienceEvidenceSchema.parse(r.evidence),
    }));
  const [assignment] = await tx<
    { employee_id: string }[]
  >`select employee_id from allrice_employee_assignments where id=${instance.assignmentId}`;
  if (!assignment) return deny();
  await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`employee-content:${owner.organizationId}`},0))`;
  const occurrence = ExperienceOccurrenceSchema.parse({
    schemaVersion: 1,
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
  const [written] =
    await tx`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,scheduled_for,status,
    experience_occurrence,completed_at,error_code) values(${occurrence.id},${rule.organization_id},${rule.workspace_id},${rule.id},
      ${rule.next_run_at!},${sources.length ? 'queued' : 'succeeded'},${tx.json(occurrence)},${sources.length ? null : new Date()},${sources.length ? null : 'EXPERIENCE_NO_NEW_EVIDENCE'})
    on conflict(automation_id,scheduled_for) where folder_event_id is null do nothing returning id`;
  if (!written) return null;
  if (!sources.length) return null; // No job, route, native runtime or model charge.
  await tx`update allrice_experience_reviews set consolidation_occurrence_id=${occurrence.id}
    where memory_id in ${tx(sources.map((s) => s.id))} and consolidation_occurrence_id is null`;
  return occurrence.id;
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
) {
  if (!experienceReviewEnabled()) throw new ExperienceError('disabled');
  const policy = await readExperiencePolicy(occurrence.organizationId, tx);
  if (
    executing &&
    (policy.frequency === 'off' ||
      runtimePolicyDigest(policy) !== occurrence.policyDigest)
  )
    return deny();
  const who = identity(occurrence);
  // Match personal-Skill mutation order and retain the shared content lock
  // through receipt commit, so a concurrent revocation cannot slip past pins.
  if (!(await readContentPrincipal(who, tx, true))) return deny();
  await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`employee-content:${occurrence.organizationId}`},0))`;
  const current = await resolveEmployeeSessionInstance(
    who,
    occurrence.assignmentId,
    occurrence.instanceId,
    tx,
  );
  if (executing && stableInstance(current) !== occurrence.instanceDigest)
    return deny();
  if (
    executing &&
    runtimePolicyDigest(await currentRules(tx, occurrence, current)) !==
      runtimePolicyDigest(occurrence.currentRules)
  )
    return deny();
  for (const source of [...occurrence.sources].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const [row] =
      await tx`select e.source_excerpt,e.source_digest,e.evidence,m.lifecycle_state,m.archived_at,
      msg.content->>'text' original_text from allrice_experience_reviews e
      join allrice_memories m on m.id=e.memory_id and m.owner_id=e.owner_id
      join allrice_chat_sessions s on s.id=e.session_id and s.owner_id=e.owner_id and s.archived_at is null
      join allrice_messages msg on msg.id=e.message_id and msg.session_id=s.id and msg.owner_id=e.owner_id and msg.role='user'
      where e.memory_id=${source.id} and e.organization_id=${occurrence.organizationId} and e.workspace_id=${occurrence.workspaceId}
        and e.owner_id=${occurrence.ownerId} and e.instance_id=${occurrence.instanceId} and e.status='pending'
        and e.consolidation_occurrence_id=${occurrence.id} and e.run_id=${source.runId} and e.message_id=${source.messageId}
        and e.session_id=${source.sessionId} for share of e,m,s,msg`;
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
    for (const evidence of source.evidence.skills) {
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
  if (row.experience_execution)
    return ExperienceExecutionSchema.parse(row.experience_execution);
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
  const execution = ExperienceExecutionSchema.parse({
    schemaVersion: 1,
    occurrenceDigest: runtimePolicyDigest(occurrence),
    model,
    nativeSkills,
    catalog,
  });
  await db`update allrice_automation_runs set experience_execution=${db.json(execution)} where id=${id}
    and experience_execution is null and run_id is null and status='queued'`;
  return ExperienceExecutionSchema.parse(
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
  await assertCurrent(tx, occurrence);
  if (
    ownerId !== occurrence.ownerId ||
    row.status !== 'queued' ||
    row.deleted_at ||
    row.automation_status !== 'enabled' ||
    (row.run_id && row.run_id !== runId)
  )
    return deny();
  const execution = ExperienceExecutionSchema.parse(row.experience_execution);
  if (
    execution.model.occurrenceId !== id ||
    execution.occurrenceDigest !== runtimePolicyDigest(occurrence)
  )
    return deny();
  await tx`update allrice_automation_runs set run_id=${runId} where id=${id} and run_id is null`;
}

export async function getExperienceExecution(runId: string) {
  return getDatabase().begin(async (tx) => {
    const [r] =
      await tx`select id from allrice_automation_runs where run_id=${runId} and experience_occurrence is not null`;
    if (!r) return deny();
    const { row, occurrence } = await loadOccurrence(tx, r.id);
    if (row.deleted_at || row.automation_status !== 'enabled') return deny();
    await assertCurrent(tx, occurrence);
    const execution = ExperienceExecutionSchema.parse(row.experience_execution);
    assertFrozenBaseSkillCatalog(execution.catalog, execution.nativeSkills);
    if (
      execution.model.occurrenceId !== occurrence.id ||
      execution.model.employeeId !== occurrence.employeeId ||
      execution.occurrenceDigest !== runtimePolicyDigest(occurrence)
    )
      return deny();
    return { occurrence, execution };
  });
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
  await assertCurrent(tx, occurrence);
  const execution = ExperienceExecutionSchema.parse(row.experience_execution);
  const output = validateExperienceDraftOutput(
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
  const receipt = ExperienceReceiptSchema.parse({
    schemaVersion: 1,
    state: 'pending_validation',
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
    state: receipt.state,
    draftCount: output.drafts.length,
  };
}

export async function recoverExperienceOccurrences(limit = 4) {
  if (!experienceReviewEnabled()) return [];
  const rows = await getDatabase()<
    { id: string }[]
  >`select id from allrice_automation_runs
    where experience_occurrence is not null and run_id is null and status='queued' order by created_at,id limit ${Math.min(limit, 16)}`;
  return rows.map((r) => r.id);
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
      await tx`select r.id,r.run_id,r.status,r.created_at,r.error_code,r.experience_occurrence,r.experience_receipt
      from allrice_automation_runs r join allrice_automations a on a.id=r.automation_id
      where r.organization_id=${context.organizationId} and r.workspace_id=${context.workspaceId!} and a.owner_id=${context.actor.id}
        and r.experience_occurrence is not null and (${instanceId ?? null}::uuid is null or r.experience_occurrence->>'instanceId'=${instanceId ?? null})
      order by r.created_at desc,r.id desc limit 50`;
    const result = [];
    for (const row of rows) {
      const occurrence = ExperienceOccurrenceSchema.parse(
        row.experience_occurrence,
      );
      try {
        await assertCurrent(tx, occurrence, false);
      } catch (error) {
        if (
          error instanceof ExperienceError ||
          error instanceof DataAccessError ||
          error instanceof EmployeeInstanceError ||
          error instanceof PersonalSkillError
        )
          continue;
        throw error;
      }
      const receipt = row.experience_receipt
        ? ExperienceReceiptSchema.parse(row.experience_receipt)
        : null;
      result.push({
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
        drafts: receipt?.output.drafts ?? [],
      });
    }
    return result;
  });
}
