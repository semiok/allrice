import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import { DEntryNativeUnavailable } from './native-owner.js';

/** Trusted composition only. This port grants no catalog or execution access. */
export interface DEntryNativePrewarmPort {
  prewarm(
    context: RequestContext,
    identity: DEntryIdentity,
    trigger: 'page' | 'input',
    signal: AbortSignal,
    revoked: AbortSignal,
  ): Promise<void>;
}

let installed: DEntryNativePrewarmPort | undefined;
export function installDEntryNativePrewarmPort(port: DEntryNativePrewarmPort) {
  if (installed) throw new DEntryNativeUnavailable();
  installed = port;
  return () => {
    if (installed === port) installed = undefined;
  };
}

export const dEntryNativePrewarmPort: DEntryNativePrewarmPort = {
  prewarm(context, identity, trigger, signal, revoked) {
    signal.throwIfAborted();
    if (!installed) throw new DEntryNativeUnavailable();
    return installed.prewarm(context, identity, trigger, signal, revoked);
  },
};
