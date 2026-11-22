import {
  AdministrationTargetProjectionSchema,
  CurrentEmployeeBusinessProjectionSchema,
  EmployeeBusinessTargetProjectionSchema,
  type AdministrationTargetProjection,
  type EmployeeBusinessTargetProjection,
  type RequestContext,
} from '@allrice/contracts';
import {
  assertBusinessScope,
  denyBusinessProjection,
  EmployeeBusinessRuntimeError,
  readBusinessProjection,
  type CurrentEmployeeBusinessSources,
} from './contract.ts';

/** Thin host projection. The owner reader must use original current authority;
 * matching IDs, binding fields and this schema cannot establish that authority. */
export async function currentEmployeeBusiness(
  sources: CurrentEmployeeBusinessSources,
  context: RequestContext,
  input: EmployeeBusinessTargetProjection,
  signal?: AbortSignal,
) {
  const target = EmployeeBusinessTargetProjectionSchema.parse(input);
  const read = sources[target.access];
  const dependency = `current.${target.access}`;
  const current = await readBusinessProjection(
    dependency,
    read && (() => read(context, target, signal)),
    CurrentEmployeeBusinessProjectionSchema,
    signal,
  );
  assertBusinessScope(context, current.scope, dependency);
  if (
    current.scope.workspaceId !== target.workspaceId ||
    current.scope.employeeInstanceId !== target.employeeInstanceId ||
    current.threadId !== target.threadId ||
    current.access !== target.access ||
    (target.access === 'execute' && current.executionGeneration !== '4.0')
  )
    denyBusinessProjection(dependency);
  if (target.module.kind === 'not-applicable') {
    if (current.module.kind !== 'not-applicable')
      denyBusinessProjection(dependency);
  } else {
    if (current.module.kind !== 'required') denyBusinessProjection(dependency);
    const binding = current.module.binding;
    const release = target.module.release;
    if (
      binding.organizationId.toLowerCase() !== current.scope.organizationId ||
      binding.workspaceId !== current.scope.workspaceId ||
      binding.ownerId.toLowerCase() !== current.scope.ownerId ||
      binding.instanceId !== current.scope.employeeInstanceId ||
      binding.revokedAt !== null ||
      binding.release.moduleId !== release.moduleId ||
      binding.release.contractVersion !== release.contractVersion ||
      binding.release.contentVersion !== release.contentVersion ||
      binding.release.digest !== release.digest
    )
      denyBusinessProjection(dependency);
  }
  return current;
}

/** Administration has its own real target/operation guard, without an execute
 * fallback or changing the authenticated actor to the employee owner. */
export async function requireCurrentAdministration(
  sources: CurrentEmployeeBusinessSources,
  context: RequestContext,
  input: AdministrationTargetProjection,
  signal?: AbortSignal,
) {
  const target = AdministrationTargetProjectionSchema.parse(input);
  signal?.throwIfAborted();
  if (!sources.administration)
    throw new EmployeeBusinessRuntimeError(
      'business_runtime_dependency_unavailable',
      'current.administration',
    );
  await sources.administration(context, target, signal);
  signal?.throwIfAborted();
}
