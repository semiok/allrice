import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  ExecutionContextSchema,
  EmployeeExecutionSnapshotSchema,
  UuidSchema,
  employeeCustomizationToolsForInstance,
  type ExecutionContext,
  type EmployeeInstance,
} from '@allrice/contracts';
import { DataAccessError } from '../data.ts';
import { assertWorkbenchSession } from '../artifact-review.ts';

export type EmployeeChatCall = {
  context: ExecutionContext;
  sessionId: string;
  userMessageId: string;
  callId: string;
  worker: { attempt: number; leaseToken: string };
  arguments: unknown;
};
export function employeeChatUuid(...parts: string[]) {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function employeeChatIdentity(
  input: EmployeeChatCall,
  fail: () => never = () => {
    throw new DataAccessError('authorization_denied');
  },
) {
  const ctx = ExecutionContextSchema.parse(input.context);
  if (
    !ctx.workspaceId ||
    ctx.policySnapshot.organizationId !== ctx.organizationId ||
    ctx.delegatedBy.type !== 'user' ||
    ctx.delegatedBy.id !== ctx.policySnapshot.subjectId ||
    Date.parse(ctx.policySnapshot.expiresAt) <= Date.now() ||
    !input.callId ||
    input.callId.length > 200 ||
    !Number.isSafeInteger(input.worker.attempt) ||
    input.worker.attempt < 0
  )
    fail();
  UuidSchema.parse(input.sessionId);
  UuidSchema.parse(input.userMessageId);
  UuidSchema.parse(input.worker.leaseToken);
  const requestId = employeeChatUuid(
    ctx.organizationId,
    ctx.workspaceId!,
    ctx.runId,
    input.callId,
  );
  const scope = {
    actor: { type: 'user' as const, id: ctx.policySnapshot.subjectId },
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId!,
    requestId,
  };
  return { ctx, scope, requestId };
}
/** Caller holds principal, assignment and current-instance locks. Root/job
 * locks use NOWAIT and the existing whole-transaction retry to avoid inversion. */
export async function assertEmployeeChatExecution(
  tx: postgres.TransactionSql,
  input: EmployeeChatCall,
  before: EmployeeInstance,
  tool: string,
  fail: () => never = () => {
    throw new DataAccessError('authorization_denied');
  },
) {
  const { ctx, scope } = employeeChatIdentity(input, fail);
  const operation =
    tool === 'automation.create'
      ? { capability: 'automation:write' as const }
      : employeeCustomizationToolsForInstance(before.kind).find(
          (entry) => entry.name === tool,
        );
  if (!operation || before.ownerId !== scope.actor.id) fail();
  await assertWorkbenchSession(tx, scope, input.sessionId, true, 'share');
  // Cancellation takes root/job locks before employee authority. NOWAIT
  // uses the existing bounded transaction retry instead of deadlocking.
  const roots =
    await tx`select root_run_id,cancel_requested_at,cancel_request_id,deadline_at
          from allrice_runtime_roots where root_run_id=${ctx.runId} for share nowait`;
  if (
    roots.some(
      (r) =>
        r.cancel_requested_at ||
        r.cancel_request_id ||
        r.deadline_at <= new Date(),
    )
  )
    fail();
  const [live] = await tx<
    { execution_snapshot: unknown; text: string }[]
  >`select er.execution_snapshot,m.content->>'text' text
          from allrice_employee_runs er
          join allrice_runs r on r.id=er.run_id and r.organization_id=er.organization_id and r.workspace_id=er.workspace_id and r.owner_id=er.owner_id
          join allrice_jobs j on j.id=${ctx.jobId} and j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
          join allrice_chat_sessions s on s.id=er.session_id and coalesce(s.employee_instance_id,s.employee_assignment_id)=${before.id}
          join allrice_messages m on m.id=er.user_message_id and m.session_id=s.id and m.owner_id=er.owner_id and m.organization_id=er.organization_id and m.workspace_id=er.workspace_id and m.role='user'
          join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.id=${ctx.policySnapshot.id} and p.organization_id=r.organization_id and p.subject_id=r.owner_id
          where er.run_id=${ctx.runId} and er.session_id=${input.sessionId} and er.user_message_id=${input.userMessageId}
            and er.employee_assignment_id=${before.assignmentId} and er.organization_id=${ctx.organizationId} and er.workspace_id=${ctx.workspaceId!} and er.owner_id=${ctx.policySnapshot.subjectId}
            and r.state='running' and p.expires_at>clock_timestamp()
            and j.status='running' and j.worker_id=${ctx.worker.id} and j.attempt=${input.worker.attempt} and j.lease_token=${input.worker.leaseToken}
            and j.cancel_requested_at is null and j.timeout_at>clock_timestamp() and j.lease_expires_at>clock_timestamp()
            and not exists(select 1 from allrice_runtime_run_links l where l.run_id=r.id and l.root_run_id<>r.id)
          for share of er,r,j,p,m nowait`;
  if (!live) fail();
  const frozen = EmployeeExecutionSnapshotSchema.parse(live.execution_snapshot);
  if (
    frozen.schemaVersion !== 2 ||
    frozen.instance?.id !== before.id ||
    frozen.instance.kind !== before.kind
  )
    fail();
  const capability = operation.capability;
  if (
    frozen.tenantContext.organizationId !== ctx.organizationId ||
    frozen.tenantContext.workspaceId !== ctx.workspaceId ||
    frozen.tenantContext.actorId !== ctx.policySnapshot.subjectId ||
    frozen.tenantContext.policySnapshotId !== ctx.policySnapshot.id ||
    !frozen.capabilitySnapshot.grantedCapabilities.includes(capability) ||
    !frozen.capabilitySnapshot.bindings.toolNames.includes(tool)
  )
    fail();
  return { text: live.text, snapshot: frozen };
}

export async function assertEmployeeChatRun(
  ...args: Parameters<typeof assertEmployeeChatExecution>
) {
  return (await assertEmployeeChatExecution(...args)).text;
}
