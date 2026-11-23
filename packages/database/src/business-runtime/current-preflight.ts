import { isDeepStrictEqual } from 'node:util';
import {
  ApplicationBuiltinModulesProjectionSchema,
  CurrentEmployeeBusinessProjectionSchema,
  EmployeeBusinessTargetProjectionSchema,
  EmployeeEffectiveContentSchema,
  EmployeeInstanceSchema,
  UuidSchema,
  sameDEntryIdentity,
  type EmployeeBusinessTargetProjection,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import {
  requireDEntryNativeIdentity,
  resolveDEntryIdentity,
} from '../d-entry.ts';
import {
  getEmployeeInstance,
  getEmployeeInstanceForHistory,
} from '../employees/employee-instances.ts';
import { getEffectiveEmployeeContent } from '../employees/employee-content.ts';
import { getSessionExecutionGeneration } from '../workspace/service.ts';
import { readApplicationBuiltinModules } from '../builtin-modules.ts';

/** This reader owns no later writer transaction. Its independent original
 * authority reads must not be used as a same-session fence or execution pin. */
export class EmployeeBusinessCurrentUnavailable extends Error {
  constructor(readonly dependency: string) {
    super('employee_business_current_dependency_unavailable');
  }
}

const sameUuid = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();
const deny = (): never => {
  throw new DataAccessError('authorization_denied');
};

async function qualified(
  context: RequestContext,
  target: EmployeeBusinessTargetProjection,
  sql: ReturnType<typeof getDatabase>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (
    context.actor.type !== 'user' ||
    (context.workspaceId !== null &&
      !sameUuid(context.workspaceId, target.workspaceId))
  )
    deny();
  const selection = {
    workspaceId: target.workspaceId,
    employeeInstanceId: target.employeeInstanceId,
    ...(target.threadId ? { threadId: target.threadId } : {}),
  };
  // These original 271 wrappers retain their own current DB authentication,
  // release and history/write distinction. They do not accept this sql handle.
  const identity =
    target.access === 'execute'
      ? await requireDEntryNativeIdentity(context, selection)
      : await resolveDEntryIdentity(context, selection, 'history');
  signal?.throwIfAborted();
  const who = { ...context, workspaceId: target.workspaceId };
  const instance = EmployeeInstanceSchema.parse(
    target.access === 'history'
      ? await getEmployeeInstanceForHistory(who, target.employeeInstanceId, sql)
      : await getEmployeeInstance(who, target.employeeInstanceId, sql),
  );
  signal?.throwIfAborted();
  if (
    !sameUuid(identity.organizationId, context.organizationId) ||
    !sameUuid(identity.personId, context.actor.id) ||
    !sameUuid(identity.workspaceId, target.workspaceId) ||
    !sameUuid(identity.employeeInstanceId, instance.id) ||
    identity.threadId !== target.threadId ||
    identity.employeeRevision !== instance.revision ||
    !sameUuid(identity.employeeVersionId, instance.source.employeeVersionId) ||
    !sameUuid(instance.organizationId, context.organizationId) ||
    !sameUuid(instance.workspaceId, target.workspaceId) ||
    !sameUuid(instance.ownerId, context.actor.id)
  )
    deny();
  // Project the real assignment mapping; this is not a second authority gate.
  // History deliberately adds no active/execute predicate to its old guard.
  const [assignment] = await sql<
    { employee_id: string; employee_version_id: string }[]
  >`select employee_id,employee_version_id from allrice_employee_assignments
    where id=${instance.assignmentId} and organization_id=${instance.organizationId}
      and workspace_id=${instance.workspaceId} and user_id=${instance.ownerId}
      and employee_version_id=${instance.source.employeeVersionId}`;
  signal?.throwIfAborted();
  if (!assignment) return deny();
  const employeeId = UuidSchema.parse(assignment.employee_id).toLowerCase();
  const generation = target.threadId
    ? await getSessionExecutionGeneration(
        context,
        target.workspaceId,
        target.threadId,
      )
    : null;
  signal?.throwIfAborted();
  if (target.access === 'execute' && generation !== '4.0') deny();
  return { identity, instance, employeeId, generation };
}

/** Current preflight only. Management content is today's authorized content,
 * including its original candidate visibility, never the adopted native config.
 * 271/default getDatabase reads below are NOT inside a later caller's SQL tx.
 * No row locks, native lifecycle, B/source or historical configuration is made.
 * Original authentication may retain its existing audit/last-seen behavior. */
export async function readEmployeeBusinessCurrentPreflight(
  context: RequestContext,
  input: EmployeeBusinessTargetProjection,
  db = getDatabase(),
  signal?: AbortSignal,
) {
  const target = EmployeeBusinessTargetProjectionSchema.parse(input);
  const before = await qualified(context, target, db, signal);
  if (target.module.kind === 'required')
    // Existing non-builtin callers keep their original exact binding/config
    // source. This new reader cannot invent that original configDigest.
    throw new EmployeeBusinessCurrentUnavailable('module.binding-config');
  const applicationModules =
    target.module.kind === 'builtin'
      ? ApplicationBuiltinModulesProjectionSchema.parse(
          await readApplicationBuiltinModules('worker'),
        )
      : null;
  signal?.throwIfAborted();
  // Content's own current authority decides draft/department visibility only
  // after policy I/O has joined; the earlier identity is not a content fence.
  const currentConfiguration =
    target.access === 'management'
      ? EmployeeEffectiveContentSchema.parse(
          await getEffectiveEmployeeContent(
            { ...context, workspaceId: target.workspaceId },
            target.employeeInstanceId,
            db,
          ),
        )
      : null;
  signal?.throwIfAborted();
  if (
    currentConfiguration &&
    (!sameUuid(currentConfiguration.instanceId, before.instance.id) ||
      !sameUuid(currentConfiguration.employeeId, before.employeeId))
  )
    deny();
  const current = await qualified(context, target, db, signal);
  if (
    !sameDEntryIdentity(before.identity, current.identity) ||
    before.employeeId !== current.employeeId ||
    before.generation !== current.generation ||
    !sameUuid(before.instance.assignmentId, current.instance.assignmentId) ||
    before.instance.archivedAt !== current.instance.archivedAt ||
    !isDeepStrictEqual(before.instance.source, current.instance.source)
  )
    deny();
  const module =
    target.module.kind === 'builtin'
      ? { ...target.module, applicationModules }
      : target.module;
  const projection = CurrentEmployeeBusinessProjectionSchema.parse({
    scope: {
      organizationId: current.instance.organizationId,
      workspaceId: current.instance.workspaceId,
      ownerId: current.instance.ownerId,
      employeeInstanceId: current.instance.id,
      employeeId: current.employeeId,
    },
    threadId: target.threadId,
    access: target.access,
    // An encoding of two existing persisted identity facts, not a new version,
    // config digest, permission token or transferable authority.
    identityRevisionRef: JSON.stringify({
      instanceRevision: current.instance.revision,
      employeeVersionId: current.instance.source.employeeVersionId,
    }),
    executionGeneration: current.generation === '4.0' ? '4.0' : null,
    module,
  });
  return { projection, identity: current.identity, currentConfiguration };
}
