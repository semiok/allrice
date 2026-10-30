import type { DshProtocolClient } from '../dsh-protocol-client.js';
import { HandlerError } from '../../errors.js';
import type { NativeSubagentControlScope } from '@allrice/contracts';
import type { DshRuntime } from './runtime-pool.js';

/** Compare server-frozen command provenance to the already executing Host. */
export function assertNativeControlScope(
  runtime: DshRuntime | undefined,
  scope: NativeSubagentControlScope,
) {
  const execution = runtime?.executionObservation;
  const pin = runtime?.nativePin;
  if (
    !runtime ||
    !execution ||
    !pin ||
    runtime.sessionId !== scope.nativeRootId ||
    pin.nativeSessionId !== scope.nativeRootId ||
    pin.contextKind !== 'chat' ||
    pin.bindingBasis !== 'business_root_origin' ||
    pin.contextId !== runtime.productSessionId ||
    pin.organizationId !== runtime.organizationId ||
    pin.workspaceId !== runtime.workspaceId ||
    pin.ownerId !== runtime.ownerId ||
    execution.runId !== scope.rootRunId ||
    execution.jobId !== scope.jobId ||
    execution.attempt !== scope.jobAttempt ||
    execution.generation !== scope.generation ||
    runtime.nativeGeneration !== scope.generation ||
    pin.rootOriginDigest !== scope.rootOriginDigest ||
    pin.storageNamespace !== scope.storageNamespace
  )
    throw Error('NATIVE_CONTROL_SCOPE_MISMATCH');
  return runtime;
}

/** Ordered native start observations only; not a child execution/terminal mirror. */
export function nativeRunScope(
  client: DshProtocolClient,
  root: string,
  runId: string,
) {
  const sessions = new Map<string, Record<string, unknown>>();
  const fields = [
    'runId',
    'nativeSessionId',
    'rootSessionId',
    'parentSessionId',
    'delegationDepth',
  ];
  const unsubscribe = client.subscribe(({ method, params }) => {
    if (
      method !== 'allrice.run-session' ||
      params.runId !== runId ||
      params.rootSessionId !== root
    )
      return;
    const id = params.nativeSessionId;
    const parent = sessions.get(String(params.parentSessionId));
    if (
      typeof id !== 'string' ||
      (id === root
        ? params.parentSessionId !== null || params.delegationDepth !== 0
        : !parent ||
          params.delegationDepth !== Number(parent.delegationDepth) + 1)
    )
      return;
    sessions.set(
      id,
      Object.fromEntries(fields.map((key) => [key, params[key]])),
    );
  });
  return {
    unsubscribe,
    check(params: Record<string, unknown>) {
      const identity = sessions.get(String(params.nativeSessionId));
      if (!identity || fields.some((key) => identity[key] !== params[key]))
        throw new HandlerError(
          'DSH_RUN_SESSION_DENIED',
          '原生调用不属于当前运行。',
          false,
        );
      // Preserve the real caller; strip only the transport authority envelope
      // before passing to existing strict domain ports.
      return Object.fromEntries(
        Object.entries(params).filter(
          ([key]) => key === 'nativeSessionId' || !fields.includes(key),
        ),
      );
    },
  };
}
