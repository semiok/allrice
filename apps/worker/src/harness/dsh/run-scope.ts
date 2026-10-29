import type { DshProtocolClient } from '../dsh-protocol-client.js';
import { HandlerError } from '../../errors.js';

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
