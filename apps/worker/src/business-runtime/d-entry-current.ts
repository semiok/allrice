import {
  DEntryIdentitySchema,
  DEntrySelectionInputSchema,
  EmployeeInstanceSchema,
  type DEntryIdentity,
  type EmployeeInstance,
  type RequestContext,
} from '@allrice/contracts';
import {
  getEmployeeInstance,
  getEmployeeInstanceForHistory,
  requireDEntryNativeIdentity,
  resolveDEntryIdentity,
} from '@allrice/database';
import {
  denyBusinessProjection,
  EmployeeBusinessRuntimeError,
} from './contract.ts';

export type DEntryBusinessIdentityProjection = {
  identity: DEntryIdentity;
  instance: Pick<
    EmployeeInstance,
    | 'id'
    | 'assignmentId'
    | 'organizationId'
    | 'workspaceId'
    | 'ownerId'
    | 'revision'
    | 'source'
    | 'archivedAt'
  >;
};

const sameUuid = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

/** Original authenticated context only. These are the actual 271/public
 * instance readers, with no history fallback for execute or guest authority.
 * This projection supplies neither employeeId nor module/B/source permission.
 * The memory owner still resolves its actual employee mapping/current locks
 * inside the original caller transaction. Separate reads are not a fence.
 * 271's reads have no signal parameter: await them before suppressing late
 * results rather than claiming the caller canceled their SQL transport. */
export async function readDEntryBusinessIdentity(
  context: RequestContext,
  input: unknown,
  access: 'history' | 'execute',
  signal?: AbortSignal,
): Promise<DEntryBusinessIdentityProjection> {
  signal?.throwIfAborted();
  if (access !== 'history' && access !== 'execute')
    throw new EmployeeBusinessRuntimeError(
      'business_runtime_projection_invalid',
      'identity.access',
    );
  const selected = DEntrySelectionInputSchema.parse(input);
  if (
    context.actor.type !== 'user' ||
    (context.workspaceId !== null &&
      !sameUuid(context.workspaceId, selected.workspaceId))
  )
    denyBusinessProjection('identity.current');
  const identity = DEntryIdentitySchema.parse(
    access === 'execute'
      ? await requireDEntryNativeIdentity(context, selected)
      : await resolveDEntryIdentity(context, selected, 'history'),
  );
  signal?.throwIfAborted();
  if (
    !sameUuid(identity.organizationId, context.organizationId) ||
    !sameUuid(identity.personId, context.actor.id) ||
    !sameUuid(identity.workspaceId, selected.workspaceId) ||
    !sameUuid(identity.employeeInstanceId, selected.employeeInstanceId) ||
    (selected.threadId
      ? identity.threadId === null ||
        !sameUuid(identity.threadId, selected.threadId)
      : identity.threadId !== null)
  )
    denyBusinessProjection('identity.current');
  const who = { ...context, workspaceId: selected.workspaceId };
  const instance = EmployeeInstanceSchema.parse(
    access === 'execute'
      ? await getEmployeeInstance(who, identity.employeeInstanceId)
      : await getEmployeeInstanceForHistory(who, identity.employeeInstanceId),
  );
  signal?.throwIfAborted();
  if (
    !sameUuid(instance.id, identity.employeeInstanceId) ||
    !sameUuid(instance.organizationId, identity.organizationId) ||
    !sameUuid(instance.workspaceId, identity.workspaceId) ||
    !sameUuid(instance.ownerId, identity.personId) ||
    instance.revision !== identity.employeeRevision ||
    !sameUuid(instance.source.employeeVersionId, identity.employeeVersionId) ||
    (access === 'execute' && instance.archivedAt != null)
  )
    denyBusinessProjection('identity.instance');
  const {
    id,
    assignmentId,
    organizationId,
    workspaceId,
    ownerId,
    revision,
    source,
    archivedAt,
  } = instance;
  return {
    identity,
    instance: {
      id,
      assignmentId,
      organizationId,
      workspaceId,
      ownerId,
      revision,
      source,
      archivedAt,
    },
  };
}
