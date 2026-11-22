import { sameDEntryIdentity } from '@allrice/contracts';
import {
  DataAccessError,
  requireDEntryNativeIdentity,
} from '@allrice/database';
import type { PersonVmPort } from '@allrice/person-vm';
import { DEntryNativeUnavailable } from '../d-entry/native-owner.js';
import {
  installDEntryNativePrewarmPort,
  type DEntryNativePrewarmPort,
} from '../d-entry/native-prewarm.js';
import { installAssignedDEntryNativeCatalog } from './native-catalog.js';

/** Consume the existing VM lifecycle; no completed-result or authority cache. */
export function createDEntryNativePrewarmPort(input: {
  vm: Pick<PersonVmPort, 'prewarm'>;
  lifetime: AbortSignal;
}) {
  input.lifetime.throwIfAborted();
  const stopped = new AbortController();
  const admission = AbortSignal.any([input.lifetime, stopped.signal]);
  const pending = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const port: DEntryNativePrewarmPort = {
    prewarm(context, identity, trigger, caller, revoked) {
      if (admission.aborted) return Promise.reject(admission.reason);
      const task = Promise.resolve().then(async () => {
        const active = AbortSignal.any([admission, caller, revoked]);
        const selection = {
          workspaceId: identity.workspaceId,
          employeeInstanceId: identity.employeeInstanceId,
          ...(identity.threadId ? { threadId: identity.threadId } : {}),
        };
        async function current() {
          active.throwIfAborted();
          const next = await requireDEntryNativeIdentity(context, selection);
          active.throwIfAborted();
          if (!sameDEntryIdentity(identity, next))
            throw new DataAccessError('authorization_denied');
        }
        await current();
        active.throwIfAborted();
        // Browser disconnect/uninstallation cannot kill shared running work.
        // Genuine authority revocation still fences this physical operation.
        const result = await input.vm.prewarm(
          context,
          { trigger },
          AbortSignal.any([input.lifetime, revoked]),
        );
        await current();
        if (
          result.personId !== identity.personId ||
          result.organizationId !== identity.organizationId
        )
          throw new DataAccessError('authorization_denied');
      });
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
      return task;
    },
  };
  return {
    port,
    close() {
      if (closing) return closing;
      stopped.abort(new DEntryNativeUnavailable());
      // Wait for actual create/start settlement; never stop or delete the VM.
      closing = Promise.allSettled([...pending]).then(() => {});
      return closing;
    },
  };
}

export function installDEntryNativePrewarm(input: {
  vm: Pick<PersonVmPort, 'prewarm'>;
  lifetime: AbortSignal;
}) {
  const assembly = createDEntryNativePrewarmPort(input);
  let uninstall: () => void;
  try {
    uninstall = installDEntryNativePrewarmPort(assembly.port);
  } catch (error) {
    void assembly.close();
    throw error;
  }
  const close = () => {
    uninstall();
    input.lifetime.removeEventListener('abort', abort);
    return assembly.close();
  };
  const abort = () => {
    void close();
  };
  input.lifetime.addEventListener('abort', abort, { once: true });
  if (input.lifetime.aborted) abort();
  return { close };
}

/** A real production composition can install both narrow ports together.
 * Construction of its actual VM/runtime/configuration remains its prerequisite. */
export function installAssignedDEntryNativeRuntime(
  input: Omit<
    Parameters<typeof installAssignedDEntryNativeCatalog>[0],
    'vm'
  > & {
    vm: Pick<PersonVmPort, 'prewarm' | 'resolve' | 'assertCurrentBinding'>;
  },
) {
  const catalog = installAssignedDEntryNativeCatalog(input);
  let prewarm: ReturnType<typeof installDEntryNativePrewarm>;
  try {
    prewarm = installDEntryNativePrewarm(input);
  } catch (error) {
    void catalog.close();
    throw error;
  }
  return {
    async close() {
      await Promise.all([prewarm.close(), catalog.close()]);
    },
  };
}
