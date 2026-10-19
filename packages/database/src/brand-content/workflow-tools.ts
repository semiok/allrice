import type postgres from 'postgres';
import {
  EmployeeExecutionSnapshotSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { getEmployeeInstance } from '../employees/employee-instances.ts';
import {
  assertEmployeeChatExecution,
  employeeChatIdentity,
  type EmployeeChatCall,
} from '../employees/employee-chat-authority.ts';
import { requireBrandContentScope } from './authority.ts';
import { assertWorkflowPackageExecution } from '../capabilities/workflow-packages.ts';
import { workflowDigest } from '../execution/workflow-runtime.ts';
import { employeeAccessTransaction } from '../employees/employee-access-cancellation.ts';

/** Called only by the private Tool Broker. Execution IDs are correlation IDs,
 * never browser logins; each data transaction rechecks current identity + lease. */
export async function authorizeBrandContentTool(
  call: EmployeeChatCall,
  tool: 'workspace.brand_content.read' | 'workspace.brand_content.step',
) {
  const { ctx, scope } = employeeChatIdentity(call);
  const [run] = await getDatabase()<
    { execution_snapshot: unknown }[]
  >`select execution_snapshot from allrice_employee_runs
    where run_id=${ctx.runId} and organization_id=${ctx.organizationId}
      and workspace_id=${ctx.workspaceId!} and owner_id=${ctx.policySnapshot.subjectId}
      and session_id=${call.sessionId} and user_message_id=${call.userMessageId}`;
  if (!run) throw new DataAccessError('authorization_denied');
  const snapshot = EmployeeExecutionSnapshotSchema.parse(
    run.execution_snapshot,
  );
  if (snapshot.schemaVersion !== 2 || snapshot.instance?.kind !== 'custom')
    throw new DataAccessError('authorization_denied');
  const instanceId = snapshot.instance.id;
  const context: RequestContext = {
    ...scope,
    sessionId: ctx.executionId,
    memberships: ctx.policySnapshot.memberships,
    authenticatedAt: ctx.startedAt,
  };
  const beforeCommit = async (tx: postgres.TransactionSql) => {
    await requireBrandContentScope(
      tx,
      context,
      {
        workspaceId: scope.workspaceId,
        instanceId,
      },
      tool === 'workspace.brand_content.step',
      'workflow',
    );
    const instance = await getEmployeeInstance(scope, instanceId, tx);
    const live = await assertEmployeeChatExecution(tx, call, instance, tool);
    if (tool === 'workspace.brand_content.step') {
      const invocation = live.snapshot.workflowInvocation;
      if (!invocation || invocation.instanceId !== instanceId)
        throw new DataAccessError('authorization_denied');
      const selected = await assertWorkflowPackageExecution(
        scope,
        {
          workspaceId: scope.workspaceId,
          instanceId,
          sceneId: invocation.sceneId,
          workflowRevisionId: invocation.workflowRevisionId,
          frozenPackageDigest: invocation.packageDigest,
        },
        tx,
        true,
      );
      if (selected.package.manifest.templateKey !== invocation.templateKey)
        throw new DataAccessError('authorization_denied');
      const [step] = await tx`select s.id from allrice_workflow_step_runs s
        join allrice_workflow_runs w on w.id=s.workflow_run_id
        where w.run_id=${ctx.runId} and w.organization_id=${ctx.organizationId}
          and w.workspace_id=${ctx.workspaceId!} and w.owner_id=${ctx.policySnapshot.subjectId}
          and w.workflow_revision_id=${invocation.workflowRevisionId}
          and s.idempotency_key=${call.callId} and s.status='running'
          and s.lease_token=${call.worker.leaseToken} and s.lease_expires_at>clock_timestamp()
          and s.input_digest=${workflowDigest(call.arguments)} for share of s,w nowait`;
      if (!step) throw new DataAccessError('authorization_denied');
    }
  };
  await employeeAccessTransaction(getDatabase(), beforeCommit);
  return {
    context,
    instanceId,
    invocation: snapshot.workflowInvocation,
    beforeCommit,
  };
}

export async function getBrandContentPublishedVersion(
  context: RequestContext,
  sessionId: string,
  versionId: string,
  tx: postgres.TransactionSql,
) {
  const [file] = await tx<
    { version_id: string; object_id: string; checksum: string }[]
  >`select v.id version_id,o.id object_id,o.checksum from allrice_deliverable_versions v
    join allrice_storage_objects o on o.id=v.object_id and o.organization_id=v.organization_id
      and o.workspace_id=v.workspace_id and o.owner_id=v.owner_id
    where v.id=${versionId} and v.session_id=${sessionId}
      and v.organization_id=${context.organizationId} and v.workspace_id=${context.workspaceId!}
      and v.owner_id=${context.actor.id} and v.platform_test_run_id is null
      and o.state='ready' and o.deleted_at is null and o.immutable
      and (o.retention_until is null or o.retention_until>clock_timestamp())`;
  if (!file) throw new DataAccessError('not_found');
  return {
    objectId: file.object_id,
    versionId: file.version_id,
    checksum: file.checksum,
  };
}
