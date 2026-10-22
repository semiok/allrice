import { z } from 'zod';
import type { TransactionSql } from 'postgres';
import {
  AutomationConversationModeSchema,
  TimestampSchema,
  UuidSchema,
} from '@allrice/contracts';
import { employeeChatUuid } from './employees/employee-chat-authority.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { DataAccessError } from './data.ts';
import {
  readScheduleTarget,
  lockScheduleTarget,
  type ScheduleScope,
  type ScheduleTarget,
} from './native-schedule-authority.ts';
import type { ResourcePrincipal } from './resource-principal.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { readWorkAutomation } from './work-automation.ts';
import { scheduleIdentity } from './native-schedule-authority.ts';

const TriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual'), requestId: UuidSchema }).strict(),
  z
    .object({
      kind: z.literal('scheduled'),
      scheduledFor: TimestampSchema,
      nativeKind: z.enum(['once', 'recurring']),
      occurrenceId: UuidSchema,
    })
    .strict(),
]);
const SnapshotBodySchema = z
  .object({
    version: z.literal(1),
    automationId: UuidSchema,
    businessRevision: z.number().int().positive().safe(),
    mode: AutomationConversationModeSchema,
    sourceSessionId: UuidSchema,
    targetSessionId: UuidSchema,
    employeeAssignmentId: UuidSchema,
    employeeInstanceId: UuidSchema,
    trigger: TriggerSchema,
  })
  .strict();
export const AutomationConversationSnapshotSchema = SnapshotBodySchema.extend({
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
})
  .strict()
  .refine(
    ({ digest, ...body }) =>
      runtimePolicyDigest(body) === digest &&
      (body.mode === 'reuse'
        ? body.sourceSessionId === body.targetSessionId
        : body.sourceSessionId !== body.targetSessionId),
    'Conversation digest or source/target relation changed',
  );
export type AutomationConversationSnapshot = z.infer<
  typeof AutomationConversationSnapshotSchema
>;

export function automationConversationTargetId(
  scope: ScheduleScope,
  automationId: string,
  trigger: z.infer<typeof TriggerSchema>,
) {
  return employeeChatUuid(
    'automation-conversation-v1',
    scope.organizationId,
    scope.workspaceId,
    scope.ownerId,
    automationId,
    trigger.kind,
    trigger.kind === 'manual' ? trigger.requestId : trigger.scheduledFor,
  );
}

/** Caller holds the original principal/automation/source locks and has already
 * read exact prior AR/paid P. Target and queue are born in this same transaction. */
export async function prepareAutomationConversation(
  tx: TransactionSql,
  principal: ResourcePrincipal,
  scope: ScheduleScope,
  plan: {
    id: string;
    name: string;
    revision: number;
    session_id: string;
    employee_assignment_id: string;
    conversation_mode: string;
  },
  source: ScheduleTarget,
  triggerRaw: z.infer<typeof TriggerSchema>,
) {
  const mode = AutomationConversationModeSchema.parse(plan.conversation_mode),
    trigger = TriggerSchema.parse(triggerRaw);
  if (
    source.id !== plan.session_id ||
    source.employee_assignment_id !== plan.employee_assignment_id ||
    principal.organizationId !== scope.organizationId ||
    principal.workspaceId !== scope.workspaceId ||
    principal.actor.type !== 'user' ||
    principal.actor.id !== scope.ownerId
  )
    throw new DataAccessError('authorization_denied');
  let target = source;
  if (mode === 'new_each_run') {
    const id = automationConversationTargetId(scope, plan.id, trigger);
    if (id === source.id) throw new DataAccessError('authorization_denied');
    const { createAssignedChatSession } =
      await import('./workspace/service.ts');
    await createAssignedChatSession(
      principal,
      {
        workspaceId: scope.workspaceId,
        employeeAssignmentId: source.employee_assignment_id,
        employeeInstanceId: source.employee_instance_id,
        title: plan.name,
      },
      { sessionId: id },
      tx,
    );
    target = await readScheduleTarget(tx, scope, id);
    await lockScheduleTarget(tx, scope, target);
  }
  const body = SnapshotBodySchema.parse({
    version: 1,
    automationId: plan.id,
    businessRevision: Number(plan.revision),
    mode,
    sourceSessionId: source.id,
    targetSessionId: target.id,
    employeeAssignmentId: source.employee_assignment_id,
    employeeInstanceId: source.employee_instance_id,
    trigger,
  });
  return {
    target,
    conversation: AutomationConversationSnapshotSchema.parse({
      ...body,
      digest: runtimePolicyDigest(body),
    }),
  };
}

/** New snapshot branch only. Legacy NULL follows the original strict reuse
 * admission. Current mode/revision is intentionally not a historical Run gate. */
export async function lockAutomationConversationJobAdmission(
  tx: TransactionSql,
  jobId: string,
) {
  const [schema] =
    await tx`select exists(select 1 from information_schema.columns
    where table_schema=current_schema() and table_name='allrice_automation_runs' and column_name='conversation_snapshot') ready`;
  if (!schema?.ready) return null;
  const [row] = await tx<
    {
      id: string;
      run_id: string;
      organization_id: string;
      workspace_id: string;
      owner_id: string;
      conversation_snapshot: unknown;
    }[]
  >`select ar.id,ar.run_id,ar.organization_id,ar.workspace_id,a.owner_id,ar.conversation_snapshot
    from allrice_automation_runs ar join allrice_automations a on a.id=ar.automation_id
    join allrice_jobs j on j.run_id=ar.run_id and j.organization_id=ar.organization_id and j.workspace_id=ar.workspace_id and j.owner_id=a.owner_id
    where j.id=${jobId} and ar.conversation_snapshot is not null`;
  if (!row) return null;
  const denied = {
      scheduled: true as const,
      runId: row.run_id,
      allowed: false,
    },
    parsed = AutomationConversationSnapshotSchema.safeParse(
      row.conversation_snapshot,
    );
  if (!parsed.success) return denied;
  const frozen = parsed.data;
  if (
    frozen.trigger.kind === 'scheduled' &&
    (frozen.trigger.nativeKind === 'once'
      ? process.env.ALLRICE_NATIVE_ONCE_ENABLED
      : process.env.ALLRICE_NATIVE_RECURRING_ENABLED) !== '1'
  )
    return denied;
  const scope = {
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
    },
    principal = await readContentPrincipal(
      scheduleIdentity(scope),
      tx,
      'update_user',
    ),
    work = await readWorkAutomation(tx, { ...scope, userId: scope.ownerId });
  if (!principal?.writable || !work.available || !work.settings.cloud)
    return denied;
  const [proof] = await tx<
    { valid: boolean }[]
  >`select allrice_automation_conversation_handoff_proved(${row.id}::uuid) valid`;
  if (!proof?.valid) return denied;
  for (const sessionId of [
    ...new Set([frozen.sourceSessionId, frozen.targetSessionId]),
  ].sort()) {
    // Lock both exact private source and target against current revocation.
    const [valid] = await tx`select s.id from allrice_chat_sessions s
      join allrice_employee_assignments x on x.id=s.employee_assignment_id and x.user_id=s.owner_id and x.active
      join allrice_employees e on e.id=x.employee_id and e.organization_id=x.organization_id and e.workspace_id=x.workspace_id
      join allrice_employee_instances i on i.id=coalesce(s.employee_instance_id,s.employee_assignment_id)
        and i.assignment_id=x.id and i.owner_id=x.user_id and i.organization_id=x.organization_id and i.workspace_id=x.workspace_id
      where s.id=${sessionId} and s.organization_id=${scope.organizationId} and s.workspace_id=${scope.workspaceId} and s.owner_id=${scope.ownerId}
        and x.organization_id=s.organization_id and x.workspace_id=s.workspace_id
        and x.id=${frozen.employeeAssignmentId} and i.id=${frozen.employeeInstanceId} and i.archived_at is null
        and s.archived_at is null and s.visibility='private' and e.status='active' and e.employee_key not like 'platform-%'
        and not exists(select 1 from allrice_platform_employee_tenant_assignments p where p.organization_id=x.organization_id
          and p.workspace_id=x.workspace_id and p.tenant_employee_id=x.employee_id and not p.active)
      for share of s,x,e,i`;
    if (!valid) return denied;
  }
  if (
    frozen.trigger.kind === 'scheduled' &&
    frozen.trigger.nativeKind === 'recurring'
  ) {
    const [monthly] = await tx<
      { monthly: boolean; valid: boolean }[]
    >`select o.calendar_period_id is not null monthly,
      case when o.calendar_period_id is not null then allrice_ordinary_monthly_handoff_proved(o.occurrence_id) else true end valid
      from allrice_native_recurring_occurrences o where o.occurrence_id=${frozen.trigger.occurrenceId}`;
    if (
      !monthly ||
      !monthly.valid ||
      (monthly.monthly && process.env.ALLRICE_NATIVE_CALENDAR_ENABLED !== '1')
    )
      return denied;
  }
  return { scheduled: true as const, runId: row.run_id, allowed: true };
}
