import {
  DEntryIdentitySchema,
  DEntrySelectionInputSchema,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import {
  authorizeSessionHistoryOwner,
  authorizeSessionOwner,
  DataAccessError,
  getEmployeeInstance,
  getEmployeeInstanceForHistory,
  requireCurrentWorkspaceWriteAuthority,
} from '@allrice/database';

/** Host-only service. The caller obtains context from the real login cookie;
 * schema parsing a JSON RequestContext must never establish authentication. */
export async function resolveDEntryIdentity(
  context: RequestContext,
  input: unknown,
  access: 'history' | 'execute',
): Promise<DEntryIdentity> {
  const selection = DEntrySelectionInputSchema.parse(input);
  if (
    context.actor.type !== 'user' ||
    (context.workspaceId !== null &&
      context.workspaceId !== selection.workspaceId)
  )
    throw new DataAccessError('authorization_denied');
  const scope = { ...context, workspaceId: selection.workspaceId };
  const thread = selection.threadId
    ? await (
        access === 'history'
          ? authorizeSessionHistoryOwner
          : authorizeSessionOwner
      )(scope, selection.workspaceId, selection.threadId)
    : null;
  if (
    thread &&
    (thread.employeeInstanceId ?? thread.employeeAssignmentId) !==
      selection.employeeInstanceId
  )
    throw new DataAccessError('authorization_denied');
  // The employee service rechecks current user/session/membership. The history
  // branch deliberately preserves the owner's archived/withdrawn employee view.
  const employee = await (
    thread && access === 'history'
      ? getEmployeeInstanceForHistory
      : getEmployeeInstance
  )(scope, selection.employeeInstanceId);
  if (
    employee.ownerId !== context.actor.id ||
    employee.organizationId !== context.organizationId ||
    employee.workspaceId !== selection.workspaceId
  )
    throw new DataAccessError('authorization_denied');
  if (access === 'execute')
    await requireCurrentWorkspaceWriteAuthority(scope, selection.workspaceId);
  return DEntryIdentitySchema.parse({
    organizationId: context.organizationId,
    workspaceId: employee.workspaceId,
    personId: context.actor.id,
    employeeInstanceId: employee.id,
    employeeRevision: employee.revision,
    employeeVersionId: employee.source.employeeVersionId,
    threadId: thread?.id ?? null,
  });
}
