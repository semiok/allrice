import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import {
  ManualAutomationRunInputSchema,
  ManualAutomationRunReceiptSchema,
  RequestContextSchema,
  UuidSchema,
  type ManualAutomationRunInput,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { acquireDevAdmission } from './dev-maintenance.ts';
import { employeeChatUuid } from './employees/employee-chat-authority.ts';
import {
  lockSchedulePrincipal,
  readScheduleTarget,
  lockScheduleTarget,
  type ScheduleScope,
} from './native-schedule-authority.ts';
import { readWorkAutomation } from './work-automation.ts';
import { getRun } from './execution/queue.ts';
import type { ResourcePrincipal } from './resource-principal.ts';

type Tx = TransactionSql;
const MANUAL_PREFIX =
  '这是用户对已保存自动化任务的一次立即执行。本轮只完成原始工作，不要创建、修改或再次安排定时任务。原定计划保持不变。\n原始要求：\n';
type Plan = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  employee_assignment_id: string;
  session_id: string;
  conversation_mode: string;
  revision: number;
  status: string;
  deleted_at: Date | null;
  native_once_cancelled_at: Date | null;
  clock_owner: string;
  prompt: string;
};
type ManualRow = {
  id: string;
  manual_request_id: string;
  manual_request_digest: string;
  manual_revision: number;
  manual_requested_at: Date;
  run_id: string | null;
  session_id: string;
};
export class ManualAutomationRunError extends Error {
  constructor(
    readonly code:
      | 'request_conflict'
      | 'revision_conflict'
      | 'unavailable'
      | 'authority_denied'
      | 'content_limit'
      | 'binding_conflict',
  ) {
    super(code);
    this.name = 'ManualAutomationRunError';
  }
}
export function manualAutomationRequestDigest(
  scope: ScheduleScope,
  taskId: string,
  input: ManualAutomationRunInput,
) {
  return (
    'sha256:' +
    createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          source: 'user',
          organizationId: scope.organizationId.toLowerCase(),
          workspaceId: scope.workspaceId.toLowerCase(),
          ownerId: scope.ownerId.toLowerCase(),
          taskId: taskId.toLowerCase(),
          requestId: input.requestId.toLowerCase(),
          expectedRevision: input.expectedRevision,
        }),
      )
      .digest('hex')
  );
}
async function authority(
  tx: Tx,
  raw: RequestContext,
  workspaceId: string,
  taskId: string,
  write = false,
) {
  let context = RequestContextSchema.parse(raw);
  UuidSchema.parse(workspaceId);
  UuidSchema.parse(taskId);
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  if (context.workspaceId && context.workspaceId !== workspaceId)
    throw new DataAccessError('not_found');
  context = { ...context, workspaceId };
  const scope = {
    organizationId: context.organizationId,
    workspaceId,
    ownerId: context.actor.id,
  };
  if (write) {
    const current = await lockSchedulePrincipal(
      tx,
      scope,
      context.requestId,
      context,
    );
    context = { ...context, memberships: current.memberships };
  } else if (!(await readContentPrincipal(context, tx)))
    throw new DataAccessError('authorization_denied');
  // Same ordinary personal catalog boundary; no platform/quality/experience or
  // folder authority is obtained by supplying its automation ID.
  const [plan] = await tx<Plan[]>`select a.* from allrice_automations a
    left join allrice_employee_assignments ea on ea.id=a.employee_assignment_id and ea.organization_id=a.organization_id and ea.workspace_id=a.workspace_id
    left join allrice_employees e on e.id=ea.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    where a.id=${taskId} and a.organization_id=${scope.organizationId} and a.workspace_id=${workspaceId} and a.owner_id=${scope.ownerId}
      and a.clock_owner in ('native_once','native_recurring') and a.trigger_type='schedule'
      and a.brand_content_binding is null and a.quality_binding is null and a.experience_binding is null
      and (e.employee_key is null or e.employee_key not like 'platform-%') ${write ? tx`for update of a` : tx``}`;
  if (!plan) throw new DataAccessError('not_found');
  return { context, scope, plan };
}
async function exact(
  tx: Tx,
  scope: ScheduleScope,
  taskId: string,
  requestId: string,
) {
  const [row] = await tx<ManualRow[]>`select * from allrice_automation_runs
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and automation_id=${taskId} and manual_request_id=${requestId} and manual_source='user'`;
  return row;
}
export async function getManualAutomationRun(
  raw: RequestContext,
  workspaceId: string,
  taskId: string,
  requestId: string,
  runId?: string,
) {
  UuidSchema.parse(requestId);
  if (runId) UuidSchema.parse(runId);
  const { context, row, scope } = await getDatabase().begin(async (tx) => {
    const access = await authority(tx, raw, workspaceId, taskId);
    const row = await exact(tx, access.scope, taskId, requestId);
    if (!row?.run_id || (runId && row.run_id !== runId))
      throw new DataAccessError('not_found');
    return { ...access, row };
  });
  const request = {
    requestId: row.manual_request_id,
    expectedRevision: Number(row.manual_revision),
  };
  if (
    manualAutomationRequestDigest(scope, taskId, request) !==
    row.manual_request_digest
  )
    throw new ManualAutomationRunError('binding_conflict');
  return ManualAutomationRunReceiptSchema.parse({
    source: 'manual',
    taskId,
    request,
    requestDigest: row.manual_request_digest,
    automationRunId: row.id,
    requestedAt: row.manual_requested_at.toISOString(),
    sessionId: row.session_id,
    run: await getRun(context, workspaceId, row.run_id!),
  });
}
type Reservation = {
  context: RequestContext;
  plan: Plan;
  row: ManualRow;
  employeeInstanceId: string;
};
const reservations = new WeakMap<Tx, Reservation>();
export function manualAutomationMessageReservation(
  tx: Tx,
  context: ResourcePrincipal,
  manualRunId: string,
) {
  const r = reservations.get(tx);
  if (!r || r.row.id !== manualRunId || !isDeepStrictEqual(r.context, context))
    throw new ManualAutomationRunError('binding_conflict');
  const prompt = MANUAL_PREFIX + r.plan.prompt;
  if (prompt.length > 40_000)
    throw new ManualAutomationRunError('content_limit');
  return {
    workspaceId: r.plan.workspace_id,
    sessionId: r.row.session_id,
    clientMessageId: r.row.id,
    prompt,
  };
}
export async function assertManualAutomationQueueBinding(
  tx: Tx,
  context: RequestContext,
  manualRunId: string,
  binding: {
    sessionId: string;
    employeeAssignmentId: string;
    userMessageId: string;
    promptSnapshot: Record<string, unknown>;
    executionSnapshot: { instance?: { id: string } };
  },
  clientMessageId: string,
) {
  const input = manualAutomationMessageReservation(tx, context, manualRunId),
    r = reservations.get(tx)!;
  if (
    binding.sessionId !== input.sessionId ||
    binding.employeeAssignmentId !== r.plan.employee_assignment_id ||
    binding.executionSnapshot.instance?.id !== r.employeeInstanceId ||
    clientMessageId !== input.clientMessageId ||
    binding.promptSnapshot.userRequest !== input.prompt
  )
    throw new ManualAutomationRunError('binding_conflict');
  const rows =
    await tx`select id from allrice_messages where id=${binding.userMessageId} and session_id=${input.sessionId}
    and organization_id=${context.organizationId} and workspace_id=${input.workspaceId} and owner_id=${context.actor.id}
    and role='user' and client_message_id=${clientMessageId} and content->>'text'=${input.prompt}`;
  if (rows.length !== 1) throw new ManualAutomationRunError('binding_conflict');
}
/** One explicit browser request, one ordinary message/Run/Job transaction. No
 * native receipt, Task mutation, timer or synthetic login participates. */
export async function runManualAutomation(
  raw: RequestContext,
  workspaceId: string,
  taskId: string,
  inputRaw: unknown,
) {
  const parsed = ManualAutomationRunInputSchema.parse(inputRaw);
  const input = { ...parsed, requestId: parsed.requestId.toLowerCase() };
  await getDatabase()
    .begin(async (tx) => {
      await acquireDevAdmission(tx);
      const { context, scope, plan } = await authority(
        tx,
        raw,
        workspaceId,
        taskId,
        true,
      );
      const digest = manualAutomationRequestDigest(scope, taskId, input);
      const existing = await exact(tx, scope, taskId, input.requestId);
      if (existing) {
        if (existing.manual_request_digest !== digest)
          throw new ManualAutomationRunError('request_conflict');
        return; // Original revision/Run survives later plan edits/deletion.
      }
      if (
        plan.deleted_at ||
        plan.native_once_cancelled_at ||
        !['enabled', 'paused'].includes(plan.status) ||
        plan.conversation_mode !== 'reuse' ||
        !plan.session_id
      )
        throw new ManualAutomationRunError('unavailable');
      if (Number(plan.revision) !== input.expectedRevision)
        throw new ManualAutomationRunError('revision_conflict');
      if (MANUAL_PREFIX.length + plan.prompt.length > 40_000)
        throw new ManualAutomationRunError('content_limit');
      const settings = await readWorkAutomation(tx, {
        ...scope,
        userId: scope.ownerId,
      });
      if (!settings.available || !settings.settings.cloud)
        throw new DataAccessError('authorization_denied');
      const target = await readScheduleTarget(tx, scope, plan.session_id);
      await lockScheduleTarget(tx, scope, target);
      if (target.employee_assignment_id !== plan.employee_assignment_id)
        throw new ManualAutomationRunError('binding_conflict');
      const id = employeeChatUuid(
        'automation-manual-v1',
        scope.organizationId,
        workspaceId,
        scope.ownerId,
        taskId,
        input.requestId,
      );
      const [row] = await tx<ManualRow[]>`insert into allrice_automation_runs
      (id,organization_id,workspace_id,automation_id,session_id,status,scheduled_for,
       manual_request_id,manual_request_digest,manual_revision,manual_source,manual_requested_at)
      values(${id},${scope.organizationId},${workspaceId},${taskId},${target.id},'queued',date_trunc('milliseconds',transaction_timestamp()),
       ${input.requestId},${digest},${input.expectedRevision},'user',date_trunc('milliseconds',transaction_timestamp())) returning *`;
      if (!row) throw new ManualAutomationRunError('binding_conflict');
      reservations.set(tx, {
        context,
        plan,
        row,
        employeeInstanceId: target.employee_instance_id,
      });
      try {
        const { prepareManualAutomationChatRunInTransaction } =
          await import('./workspace/service.ts');
        const queued = await prepareManualAutomationChatRunInTransaction(
          tx,
          context,
          id,
        );
        await tx`update allrice_automation_runs set run_id=${queued.runId} where id=${id} and run_id is null`;
        await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
        values(${scope.organizationId},${workspaceId},${scope.ownerId},'automation.manual_run','automation',${taskId},'allowed','explicit_manual_request',${context.requestId})`;
      } finally {
        reservations.delete(tx);
      }
    })
    .catch((error: unknown) => {
      // Only a confirmed rejection before COMMIT ends the saved request. Unknown
      // database/COMMIT acknowledgements never become a retryable rejection.
      if (
        error instanceof DataAccessError &&
        error.code === 'authorization_denied'
      )
        throw new ManualAutomationRunError('authority_denied');
      if (error instanceof DataAccessError && error.code === 'not_found')
        throw new ManualAutomationRunError('unavailable');
      throw error;
    });
  return getManualAutomationRun(raw, workspaceId, taskId, input.requestId);
}
