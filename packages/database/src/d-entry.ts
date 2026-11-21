import {
  DEntryIdentitySchema,
  DEntrySelectionInputSchema,
  selectDEntryGeneration,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError } from './data.ts';
import {
  authorizeSessionHistoryOwner,
  authorizeSessionOwner,
  getSessionExecutionGeneration,
} from './workspace/service.ts';
import {
  getEmployeeInstance,
  getEmployeeInstanceForHistory,
} from './employees/employee-instances.ts';
import { requireCurrentWorkspaceWriteAuthority } from './identity.ts';
import { readDEntryReleasePolicy } from './d-entry-release-policy.ts';
import { getSessionNativeSubagentTarget } from './conversation/native-subagent-query.ts';

const identityServices = {
  authorizeSessionHistoryOwner,
  authorizeSessionOwner,
  getEmployeeInstance,
  getEmployeeInstanceForHistory,
  requireCurrentWorkspaceWriteAuthority,
};

/** Host composition seam, not an authentication API. Both HTTP adapters obtain
 * context from the original session before calling the same current authority. */
export function createDEntryIdentityResolver(services = identityServices) {
  return async function resolveDEntryIdentity(
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
            ? services.authorizeSessionHistoryOwner
            : services.authorizeSessionOwner
        )(scope, selection.workspaceId, selection.threadId)
      : null;
    if (
      thread &&
      (thread.employeeInstanceId ?? thread.employeeAssignmentId) !==
        selection.employeeInstanceId
    )
      throw new DataAccessError('authorization_denied');
    const employee = await (
      thread && access === 'history'
        ? services.getEmployeeInstanceForHistory
        : services.getEmployeeInstance
    )(scope, selection.employeeInstanceId);
    if (
      employee.ownerId !== context.actor.id ||
      employee.organizationId !== context.organizationId ||
      employee.workspaceId !== selection.workspaceId
    )
      throw new DataAccessError('authorization_denied');
    if (access === 'execute')
      await services.requireCurrentWorkspaceWriteAuthority(
        scope,
        selection.workspaceId,
      );
    return DEntryIdentitySchema.parse({
      organizationId: context.organizationId,
      workspaceId: employee.workspaceId,
      personId: context.actor.id,
      employeeInstanceId: employee.id,
      employeeRevision: employee.revision,
      employeeVersionId: employee.source.employeeVersionId,
      threadId: thread?.id ?? null,
    });
  };
}

export const resolveDEntryIdentity = createDEntryIdentityResolver();

/** VM-live reads also require current write eligibility and explicit release.
 * Cold history uses resolveDEntryIdentity(..., 'history') and never enters here. */
export async function requireDEntryNativeIdentity(
  context: RequestContext,
  input: unknown,
) {
  const identity = await resolveDEntryIdentity(context, input, 'execute');
  const policy = await readDEntryReleasePolicy();
  if (
    selectDEntryGeneration(policy, identity) !== '4.0' ||
    (identity.threadId &&
      (await getSessionExecutionGeneration(
        context,
        identity.workspaceId,
        identity.threadId,
      )) !== '4.0')
  )
    throw new DataAccessError('authorization_denied');
  return identity;
}

/** Reuses the immutable host business pin. This read cannot repair/create a
 * pin, change a 3.x origin, select a catalog root or wake a VM. The current
 * 4.0 binder is an external dependency; an unbound thread fails closed. */
export async function getDEntryNativeRootPin(
  context: RequestContext,
  input: unknown,
) {
  const identity = await requireDEntryNativeIdentity(context, input);
  if (!identity.threadId) throw new DataAccessError('authorization_denied');
  const target = await getSessionNativeSubagentTarget(
    context,
    identity.workspaceId,
    identity.threadId,
  );
  return {
    identity,
    rootNativeSessionId: target.descriptor.nativeSessionId,
    rootOriginDigest: target.rootOriginDigest,
    threadGeneration: target.generation,
  };
}
