import {
  DEntrySelectionInputSchema,
  EmployeeBusinessTargetProjectionSchema,
  type EmployeeBusinessTargetProjection,
  type RequestContext,
} from '@allrice/contracts';
import {
  createBusinessRuntimeCaller,
  requireDEntryNativeIdentity,
} from '@allrice/database';
import { currentEmployeeBusiness } from './current.js';
import { EmployeeBusinessRuntimeError } from './contract.js';

type Caller = Pick<
  ReturnType<typeof createBusinessRuntimeCaller>,
  'readEmployeeBusinessCurrentPreflight'
>;

/** Production composition of real current sources, no cached authority. This
 * is a preflight consumer, not the bound current reader of a writer transaction. */
export function createWorkerCurrentBusinessRuntime(
  input: {
    caller?: Caller;
    lifetime?: AbortSignal;
  } = {},
) {
  const caller = input.caller ?? createBusinessRuntimeCaller();
  const active = (signal?: AbortSignal) => {
    const signals = [input.lifetime, signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    return signals.length ? AbortSignal.any(signals) : undefined;
  };
  async function read(
    context: RequestContext,
    value: EmployeeBusinessTargetProjection,
    signal?: AbortSignal,
  ) {
    const selected = EmployeeBusinessTargetProjectionSchema.parse(value);
    const stop = active(signal);
    let fact:
      | Awaited<ReturnType<Caller['readEmployeeBusinessCurrentPreflight']>>
      | undefined;
    const projection = await currentEmployeeBusiness(
      {
        [selected.access]: async () => {
          fact = await caller.readEmployeeBusinessCurrentPreflight(
            context,
            selected,
            stop,
          );
          return fact.projection;
        },
      },
      context,
      selected,
      stop,
    );
    if (!fact)
      throw new EmployeeBusinessRuntimeError(
        'business_runtime_dependency_unavailable',
        'current.preflight',
      );
    return { ...fact, projection };
  }
  return Object.freeze({
    read,
    async identity(context: RequestContext, value: unknown) {
      const selected = DEntrySelectionInputSchema.parse(value);
      const signal = active();
      signal?.throwIfAborted();
      if (!selected.threadId) {
        // Existing page/input admission is not a business execution. Preserve
        // its original 271 gate; never materialize a thread/4.0 pin for it.
        const identity = await requireDEntryNativeIdentity(context, selected);
        signal?.throwIfAborted();
        return identity;
      }
      const fact = await read(
        context,
        {
          ...selected,
          threadId: selected.threadId,
          access: 'execute',
          module: { kind: 'not-applicable' },
        },
        signal,
      );
      return fact.identity;
    },
  });
}
