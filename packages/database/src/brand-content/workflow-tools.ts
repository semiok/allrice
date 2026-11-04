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
import { employeeAccessTransaction } from '../employees/employee-access-cancellation.ts';

/** Called only by the private Tool Broker. Execution IDs are correlation IDs,
 * never browser logins; each data transaction rechecks current identity + lease. */
export async function authorizeBrandContentTool(
  call: EmployeeChatCall,
  tool: 'workspace.brand_content.read',
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
      false,
      'workflow',
    );
    const instance = await getEmployeeInstance(scope, instanceId, tx);
    await assertEmployeeChatExecution(tx, call, instance, tool);
  };
  await employeeAccessTransaction(getDatabase(), beforeCommit);
  return {
    context,
    instanceId,
    beforeCommit,
  };
}

