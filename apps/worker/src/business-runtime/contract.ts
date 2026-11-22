import type {
  ActualNativeCallSelectorProjection,
  ActualNativeExecutionSelectorProjection,
  AdministrationTargetProjection,
  EmployeeBusinessScopeProjection,
  EmployeeBusinessTargetProjection,
  MemoryOriginSelectorProjection,
  OriginalExecutionSelectorProjection,
  RequestContext,
  StoredHumanSourceSelectorProjection,
} from '@allrice/contracts';
import type { z } from 'zod';

/** These dependencies are host-only owner seams, never request parameters.
 * Their implementations must perform original authentication/current rights.
 * No production composition or substitute producer is installed by this slice. */
type ProjectionReader<Selector> = (
  context: RequestContext,
  selector: Selector,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Each access reader retains its original identity/resource qualification.
 * Builtins project readApplicationBuiltinModules('worker') from the trusted
 * service, bracketed by that reader's current guard; no request supplies a
 * build/policy. A null applicationBuild is unknown provenance, not a release.
 * Management current configuration is read through the existing content APIs;
 * actual/stored execution config pins remain separate original facts. Other
 * modules keep their exact binding/release/configDigest contract. */
export interface CurrentEmployeeBusinessSources {
  management?: ProjectionReader<EmployeeBusinessTargetProjection>;
  history?: ProjectionReader<EmployeeBusinessTargetProjection>;
  execute?: ProjectionReader<EmployeeBusinessTargetProjection>;
  administration?: (
    context: RequestContext,
    target: AdministrationTargetProjection,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface LogicalExecutionSources {
  actual?: ProjectionReader<ActualNativeExecutionSelectorProjection>;
  stored?: ProjectionReader<OriginalExecutionSelectorProjection>;
}

export interface HumanSourceSources {
  adopted?: ProjectionReader<ActualNativeCallSelectorProjection>;
  stored?: ProjectionReader<StoredHumanSourceSelectorProjection>;
}

export interface OrdinaryOriginSources {
  /** Already bound to the original caller's real scope/current authority and
   * transaction by its owner. No ambient/default binding exists in this slice. */
  classify?: (
    selector: MemoryOriginSelectorProjection,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export class EmployeeBusinessRuntimeError extends Error {
  constructor(
    readonly code:
      | 'business_runtime_dependency_unavailable'
      | 'business_runtime_projection_invalid'
      | 'business_runtime_authorization_denied',
    readonly dependency: string,
  ) {
    super(code);
  }
}

export function denyBusinessProjection(dependency: string): never {
  throw new EmployeeBusinessRuntimeError(
    'business_runtime_authorization_denied',
    dependency,
  );
}

/** Await real work before checking cancellation; never race or detach I/O.
 * A returned shape is only a projection, never a transferable authority. */
export async function readBusinessProjection<T>(
  dependency: string,
  read: (() => Promise<unknown>) | undefined,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!read)
    throw new EmployeeBusinessRuntimeError(
      'business_runtime_dependency_unavailable',
      dependency,
    );
  const value = await read();
  signal?.throwIfAborted();
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new EmployeeBusinessRuntimeError(
      'business_runtime_projection_invalid',
      dependency,
    );
  return parsed.data;
}

export function assertBusinessScope(
  context: RequestContext,
  scope: EmployeeBusinessScopeProjection,
  dependency: string,
) {
  if (
    context.actor.type !== 'user' ||
    scope.organizationId !== context.organizationId.toLowerCase() ||
    scope.ownerId !== context.actor.id.toLowerCase() ||
    (context.workspaceId !== null &&
      scope.workspaceId !== context.workspaceId.toLowerCase())
  )
    denyBusinessProjection(dependency);
}

export function sameBusinessScope(
  left: EmployeeBusinessScopeProjection,
  right: EmployeeBusinessScopeProjection,
) {
  return (
    left.organizationId === right.organizationId &&
    left.workspaceId === right.workspaceId &&
    left.ownerId === right.ownerId &&
    left.employeeInstanceId === right.employeeInstanceId &&
    left.employeeId === right.employeeId
  );
}
