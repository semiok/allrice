import {
  PersonVmError,
  type PersonVmBinding,
  type PersonVmRuntimePort,
} from './contract.ts';

/** Host-only structural projection of MET267's public VmMemoryGuestPlan. */
export type PersonVmMemoryGuestPlan = Readonly<{
  files: readonly Readonly<{ path: string; contents: string; mode: number }>[];
  initialize: Readonly<{ executable: 'node'; args: readonly string[] }>;
  launcher: string;
  env: Readonly<Record<string, string>>;
}>;
export type PersonVmGuestCommand = Readonly<{
  executable: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  workdir?: string;
}>;
export type PersonVmJobExit = Readonly<{ exitCode: number; timedOut: boolean }>;
export interface PersonVmManagedJob {
  readonly binding: PersonVmBinding;
  readonly jobId: string;
  /** A successful native wait proves completion, including a nonzero guest exit. */
  wait(signal: AbortSignal): Promise<PersonVmJobExit>;
  /** Exact guest process-group kill followed by wait, never just CLI termination. */
  cancelAndWait(signal: AbortSignal): Promise<PersonVmJobExit>;
}
export interface PersonVmStartingScope {
  readonly binding: PersonVmBinding;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export interface PersonVmBootstrapScope extends PersonVmStartingScope {
  /** Only after person memory init; always prepends the installed native launcher.
   * The runtime owner retains the returned job, not this expiring startup scope. */
  launch(command: PersonVmGuestCommand): Promise<PersonVmManagedJob>;
}
export interface PersonVmGuestBootstrapPort {
  bootstrap(
    scope: PersonVmStartingScope,
    plan: PersonVmMemoryGuestPlan,
  ): Promise<Pick<PersonVmBootstrapScope, 'launch'>>;
}

/** Internal service kernel: the actual lease stays owned through callback and
 * every started native operation. No detached promise is a join certificate. */
export async function bootstrapPersonVm(input: {
  binding: PersonVmBinding;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
  native: PersonVmGuestBootstrapPort;
  runtime: PersonVmRuntimePort;
}) {
  const closed = new AbortController();
  let active = true,
    failed = false;
  const pending = new Set<Promise<unknown>>();
  const scope: PersonVmStartingScope = Object.freeze({
    binding: Object.freeze({ ...input.binding }),
    signal: AbortSignal.any([input.signal, closed.signal]),
    assertCurrent: async () => {
      if (!active) throw new PersonVmError('LEASE_LOST');
      scope.signal.throwIfAborted();
      await input.assertCurrent();
      if (!active) throw new PersonVmError('LEASE_LOST');
      scope.signal.throwIfAborted();
    },
  });
  function track<T>(work: () => Promise<T>): Promise<T> {
    const operation = (async () => {
      await scope.assertCurrent();
      const result = await work();
      await scope.assertCurrent();
      return result;
    })();
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => {
        failed = true;
        pending.delete(operation);
      },
    );
    return operation;
  }
  try {
    const plan = await track(() =>
      input.runtime.memoryGuestPlan(scope.binding, scope.signal),
    );
    const launcher = await track(() => input.native.bootstrap(scope, plan));
    await input.runtime.start(
      scope.binding,
      scope.signal,
      Object.freeze({
        ...scope,
        launch: (command: PersonVmGuestCommand) =>
          track(() => launcher.launch(command)),
      }),
    );
  } finally {
    // Final service owner checks run only after this public capability closes.
    active = false;
    closed.abort();
    await Promise.allSettled([...pending]);
  }
  if (failed) throw new PersonVmError('CLEANUP_INCOMPLETE');
}
