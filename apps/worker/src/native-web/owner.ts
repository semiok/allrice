import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import * as GatewayClient from '@deepseek-ai/dsh-api-gateway/client';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import type { RequestContext } from '@allrice/contracts';
import {
  PersonVmError,
  sameVmBinding,
  type PersonVmBinding,
  type PersonVmBootstrapScope,
  type PersonVmPort,
} from '@allrice/person-vm';
import type { NativeWebLaunch } from './launch.js';
import { nativeWebTransport } from './transport.js';

/** Real public Node control owner for one already published native Web job.
 * This is not Runtime.ready, editor readiness, or a VM-wide activity producer. */
export async function openNativeWebOwner(input: {
  scope: PersonVmBootstrapScope;
  launch: NativeWebLaunch;
  context: RequestContext;
  vm: Pick<PersonVmPort, 'assertCurrentBinding'>;
  lifetime: AbortSignal;
  cleanupTimeoutMs: number;
}) {
  if (
    !input.scope.readNativeWebAuth ||
    !Number.isSafeInteger(input.cleanupTimeoutMs) ||
    input.cleanupTimeoutMs <= 0
  )
    throw new PersonVmError('PROVIDER_FAILED');
  const binding = Object.freeze({ ...input.scope.binding });
  if (!sameVmBinding(input.launch.binding, binding))
    throw new PersonVmError('LEASE_LOST');
  const stale = new AbortController(),
    waitAbort = new AbortController();
  const signal = AbortSignal.any([input.lifetime, stale.signal]);
  let ready = false,
    closing: Promise<void> | undefined,
    hostClosing: Promise<void> | undefined;
  const root = new Context();
  const operations = new Set<Promise<unknown>>();
  function own<T>(operation: Promise<T>): Promise<T> {
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  }
  let disconnected: Promise<unknown> | undefined;
  const lost = () => {
    ready = false;
    stale.abort(new PersonVmError('PROVIDER_FAILED'));
    disconnected ??= Promise.all([transport.close(), root.fiber.dispose()]);
    void disconnected.catch(() => {});
  };
  const transport = nativeWebTransport(input.launch.auth.origin, signal, lost);
  await input.scope.assertCurrent();
  input.lifetime.throwIfAborted();
  const job = await input.scope.launch(input.launch.command);
  if (!sameVmBinding(job.binding, binding)) {
    await job.cancelAndWait(AbortSignal.timeout(input.cleanupTimeoutMs));
    throw new PersonVmError('LEASE_LOST');
  }
  const nativeWait = Promise.resolve().then(() => job.wait(waitAbort.signal));
  void nativeWait.then(lost, lost);
  function joinHost() {
    if (hostClosing) return hostClosing;
    ready = false;
    hostClosing = (async () => {
      stale.abort();
      waitAbort.abort();
      // Managed wait settles only after its host CLI joins. Its rejection is
      // not guest completion; close/confirmed native stop owns that proof.
      await Promise.allSettled([nativeWait]);
      // Join an earlier loss cleanup, then obtain fresh actual I/O join results.
      // Its rejected memo is neither a success certificate nor a permanent veto.
      await Promise.allSettled([disconnected]);
      const results = await Promise.allSettled([
        transport.close(),
        root.fiber.dispose(),
      ]);
      await Promise.allSettled([...operations]);
      if (results.some((result) => result.status === 'rejected'))
        throw new PersonVmError('CLEANUP_INCOMPLETE');
    })();
    const attempt = hostClosing;
    void attempt.catch(() => {
      if (hostClosing === attempt) hostClosing = undefined;
    });
    return attempt;
  }
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      const results = await Promise.allSettled([
        joinHost(),
        job.cancelAndWait(AbortSignal.timeout(input.cleanupTimeoutMs)),
      ]);
      if (results.some((result) => result.status === 'rejected'))
        throw new PersonVmError('CLEANUP_INCOMPLETE');
    })();
    return closing;
  }
  const aborted = () => {
    void close().catch(() => {});
  };
  input.lifetime.addEventListener('abort', aborted, { once: true });
  input.scope.signal.addEventListener('abort', aborted, { once: true });
  if (input.lifetime.aborted || input.scope.signal.aborted) aborted();
  const startupTimer = setTimeout(lost, input.launch.auth.timeoutMs);
  try {
    signal.throwIfAborted();
    const auth = await input.scope.readNativeWebAuth(input.launch.auth);
    signal.throwIfAborted();
    await input.scope.assertCurrent();
    await own(transport.authenticate(auth.authenticatedUrl));
    await root.plugin(TypertRegistry);
    installConnection(root, {
      interactions: 'none',
      transport: {
        fetch: transport.fetch,
        createWebSocket: transport.createWebSocket,
        streamBaseUrl: input.launch.auth.origin,
      },
    });
    await root.plugin(GatewayClient);
    await root.remote.$mount(TYPERT_REMOTE);
    const list = await own(root.remote.session.list({}, signal));
    if (!list.ok) throw new PersonVmError('PROVIDER_FAILED');
    const stream = root.remote.session.control(signal);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await own(iterator.next());
    if (first.done || first.value.type !== 'baseline')
      throw new PersonVmError('PROVIDER_FAILED');
    await input.scope.assertCurrent();
    signal.throwIfAborted();
    ready = true;
    own(
      (async () => {
        try {
          while (!(await iterator.next()).done) signal.throwIfAborted();
        } finally {
          lost();
          await iterator.return?.();
        }
      })(),
    ).catch(() => {});
    return Object.freeze({
      binding,
      revoked: signal,
      /** Connectivity only; never conveys current execution authorization. */
      controlReady: () => ready && !signal.aborted,
      readSessions(requestSignal: AbortSignal) {
        async function assertCurrent(current: AbortSignal) {
          try {
            await input.vm.assertCurrentBinding(
              input.context,
              binding,
              current,
            );
          } catch (error) {
            if (!requestSignal.aborted) lost();
            throw error;
          }
        }
        const current = AbortSignal.any([signal, requestSignal]);
        if (current.aborted) return Promise.reject(current.reason);
        // Register before entering either asynchronous guard, including reentrant close.
        return own(
          Promise.resolve().then(async () => {
            current.throwIfAborted();
            await assertCurrent(current);
            current.throwIfAborted(); // A late guard success cannot dispatch after close.
            const result = await root.remote.session.list({}, current);
            await assertCurrent(current);
            current.throwIfAborted();
            return result;
          }),
        );
      },
      /** Only the trusted runtime's confirmed-native-stop hook may use this.
       * This does not manufacture a job exit or replace normal exact close. */
      async retireAfterNativeStop(
        current: PersonVmBinding,
        cleanup: AbortSignal,
      ) {
        if (!sameVmBinding(binding, current))
          throw new PersonVmError('LEASE_LOST');
        cleanup.throwIfAborted();
        await Promise.allSettled([closing]); // Join any old exact cancellation attempt.
        await joinHost();
        input.lifetime.removeEventListener('abort', aborted);
        cleanup.throwIfAborted();
        closing = Promise.resolve(); // New native-stop + actual host join supersedes only the old failure memo.
      },
      async close() {
        try {
          await close();
        } finally {
          input.lifetime.removeEventListener('abort', aborted);
        }
      },
    });
  } catch {
    try {
      await close();
    } finally {
      input.lifetime.removeEventListener('abort', aborted);
    }
    throw new PersonVmError('PROVIDER_FAILED');
  } finally {
    clearTimeout(startupTimer);
    input.scope.signal.removeEventListener('abort', aborted);
  }
}

export type NativeWebOwner = Awaited<ReturnType<typeof openNativeWebOwner>>;
