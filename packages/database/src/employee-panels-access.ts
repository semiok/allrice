import {
  DEntryIdentitySchema,
  DEntrySelectionInputSchema,
  RequestContextSchema,
  selectDEntryGeneration,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import { getEmployeeInstance } from './employees/employee-instances.ts';
import { readDEntryReleasePolicy } from './d-entry-release-policy.ts';
import {
  authorizeSessionHistoryOwner,
  getSessionExecutionGeneration,
} from './workspace/service.ts';

/** Browser management authority, independent of a VM, B, MCP call or native
 * receipt. Owner ACLs remain responsible for each resource and writable action.
 * Selectors never establish actor, organization, employee ownership or release. */
export async function requireEmployeePanelsAccess(
  contextInput: RequestContext,
  input: unknown,
) {
  const context = RequestContextSchema.parse(contextInput);
  const selection = DEntrySelectionInputSchema.parse(input);
  if (
    context.actor.type !== 'user' ||
    context.workspaceId !== selection.workspaceId
  )
    throw new DataAccessError('authorization_denied');
  const employee = await getEmployeeInstance(
    context,
    selection.employeeInstanceId,
  );
  if (
    employee.ownerId !== context.actor.id ||
    employee.organizationId !== context.organizationId ||
    employee.workspaceId !== selection.workspaceId
  )
    throw new DataAccessError('authorization_denied');
  if (selection.threadId) {
    const thread = await authorizeSessionHistoryOwner(
      context,
      selection.workspaceId,
      selection.threadId,
    );
    if (
      (thread.employeeInstanceId ?? thread.employeeAssignmentId) !==
        employee.id ||
      (await getSessionExecutionGeneration(
        context,
        selection.workspaceId,
        selection.threadId,
      )) !== '4.0'
    )
      throw new DataAccessError('authorization_denied');
  }
  const identity = DEntryIdentitySchema.parse({
    organizationId: context.organizationId,
    workspaceId: selection.workspaceId,
    personId: context.actor.id,
    employeeInstanceId: employee.id,
    employeeRevision: employee.revision,
    employeeVersionId: employee.source.employeeVersionId,
    threadId: selection.threadId ?? null,
  });
  if (
    selectDEntryGeneration(await readDEntryReleasePolicy(), identity) !== '4.0'
  )
    throw new DataAccessError('authorization_denied');
  return identity;
}
