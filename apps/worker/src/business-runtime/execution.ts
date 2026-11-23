import {
  ActualNativeExecutionSelectorProjectionSchema,
  LogicalExecutionBindingProjectionSchema,
  OriginalExecutionSelectorProjectionSchema,
  type ActualNativeExecutionSelectorProjection,
  type LogicalExecutionBindingProjection,
  type OriginalExecutionSelectorProjection,
  type RequestContext,
} from '@allrice/contracts';
import { z } from 'zod';
import {
  assertBusinessScope,
  denyBusinessProjection,
  readBusinessProjection,
  type LogicalExecutionSources,
} from './contract.ts';

const actualObservation = z
  .object({
    nativeRequestRef: z.string().min(1),
    binding: LogicalExecutionBindingProjectionSchema,
  })
  .strict();

function assertExecutionTarget(
  context: RequestContext,
  target:
    | ActualNativeExecutionSelectorProjection
    | OriginalExecutionSelectorProjection,
  binding: LogicalExecutionBindingProjection,
  dependency: string,
) {
  assertBusinessScope(context, binding.scope, dependency);
  if (
    binding.scope.workspaceId !== target.workspaceId ||
    binding.scope.employeeInstanceId !== target.employeeInstanceId ||
    binding.threadId !== target.threadId
  )
    denyBusinessProjection(dependency);
}

/** Only a real native observation source can associate the actual request to B.
 * This function never mints B from request, root, session, VM or login IDs. */
export async function readActualExecution(
  sources: LogicalExecutionSources,
  context: RequestContext,
  input: ActualNativeExecutionSelectorProjection,
  signal?: AbortSignal,
) {
  const target = ActualNativeExecutionSelectorProjectionSchema.parse(input);
  const read = sources.actual;
  const observed = await readBusinessProjection(
    'execution.actual',
    read && (() => read(context, target, signal)),
    actualObservation,
    signal,
  );
  assertExecutionTarget(context, target, observed.binding, 'execution.actual');
  if (observed.nativeRequestRef !== target.nativeRequestRef)
    denyBusinessProjection('execution.actual');
  return observed.binding;
}

/** Read the original persistent association only. It does not launch an
 * execution, mint another B, replay a call or promise a complete restore cut. */
export async function readStoredExecution(
  sources: LogicalExecutionSources,
  context: RequestContext,
  input: OriginalExecutionSelectorProjection,
  signal?: AbortSignal,
) {
  const target = OriginalExecutionSelectorProjectionSchema.parse(input);
  const read = sources.stored;
  const binding = await readBusinessProjection(
    'execution.stored',
    read && (() => read(context, target, signal)),
    LogicalExecutionBindingProjectionSchema,
    signal,
  );
  assertExecutionTarget(context, target, binding, 'execution.stored');
  if (binding.b !== target.b) denyBusinessProjection('execution.stored');
  return binding;
}
