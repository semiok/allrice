import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots';
import type {
  EmployeePanelsActions,
  EmployeePanelsBinding,
  EmployeePanelsReference,
  EmployeePanelsSnapshot,
} from './employee-panels-port';

export const employeePanelKinds = {
  files: 'allrice-employee-panels.files',
  materials: 'allrice-employee-panels.materials',
  experience: 'allrice-employee-panels.experience',
  workflow: 'allrice-employee-panels.workflow',
} as const;
export type EmployeePanelKind = keyof typeof employeePanelKinds;

export class EmployeePanelsUnavailableError extends Error {
  constructor() {
    super('Employee panel owner or target unavailable');
    this.name = 'EmployeePanelsUnavailableError';
  }
}

export function assertEmployeePanelSession(
  ctx: Context,
  sessionId: SessionIdOf,
) {
  if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId)
    throw new EmployeePanelsUnavailableError();
}

export function employeePanelsSnapshot(
  binding: EmployeePanelsBinding,
  sessionId: SessionIdOf,
) {
  return binding.signal.aborted ? null : binding.port.getSnapshot(sessionId);
}

/** One subscription only; owner unload clears already-mounted private content. */
export function subscribeEmployeePanels(
  binding: EmployeePanelsBinding,
  sessionId: SessionIdOf,
  listener: () => void,
) {
  if (binding.signal.aborted) return () => {};
  let removed = false;
  const remove = binding.port.subscribe(sessionId, () => {
    if (!removed) listener();
  });
  const stop = () => {
    if (removed) return;
    removed = true;
    remove();
    binding.signal.removeEventListener('abort', abort);
  };
  const abort = () => {
    stop();
    listener();
  };
  binding.signal.addEventListener('abort', abort, { once: true });
  if (binding.signal.aborted) abort();
  return stop;
}

export function assertEmployeePanelsCurrent(
  binding: EmployeePanelsBinding,
  sessionId: SessionIdOf,
  snapshot: EmployeePanelsSnapshot,
  signal: AbortSignal = binding.signal,
) {
  if (
    signal.aborted ||
    binding.signal.aborted ||
    employeePanelsSnapshot(binding, sessionId)?.scopeKey !== snapshot.scopeKey
  )
    throw new EmployeePanelsUnavailableError();
}

/** Preserve original component callback contracts, refusing detached UI intents. */
export function guardEmployeePanelProps<Props extends object>(
  props: Props,
  assertCurrent: () => void,
): Props {
  return Object.fromEntries(
    Object.entries(props).map(([key, value]) => [
      key,
      key.startsWith('on') && typeof value === 'function'
        ? (...args: unknown[]) => {
            assertCurrent();
            return Reflect.apply(value, props, args);
          }
        : value,
    ]),
  ) as Props;
}

export function insertEmployeePanelReference(
  binding: EmployeePanelsBinding,
  sessionId: SessionIdOf,
  snapshot: EmployeePanelsSnapshot,
  signal: AbortSignal,
  reference: EmployeePanelsReference,
) {
  assertEmployeePanelsCurrent(binding, sessionId, snapshot, signal);
  if (
    !binding.port.useReference?.({
      sessionId,
      scopeKey: snapshot.scopeKey,
      reference,
      signal,
    })
  )
    throw new EmployeePanelsUnavailableError();
}

export function employeePanelsActions(
  ctx: Context,
  binding: EmployeePanelsBinding,
  sessionId: SessionIdOf,
  snapshot: EmployeePanelsSnapshot,
  signal: AbortSignal,
): EmployeePanelsActions {
  const current = () => {
    assertEmployeePanelSession(ctx, sessionId);
    assertEmployeePanelsCurrent(binding, sessionId, snapshot, signal);
  };
  return {
    signal,
    async openMain(resolve) {
      current();
      const key = await resolve(signal);
      current();
      if (
        !key ||
        !ctx.slots.entries('main').some((entry) => entry.options.key === key)
      )
        throw new EmployeePanelsUnavailableError();
      ctx.layout.selectPanel(key);
    },
  };
}
