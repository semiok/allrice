/** Observation only: public host calls and public Undici/Socket events.
 * Never cancels, waits for transport close, reads payloads or authorizes work. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import type { Socket } from 'node:net';
import { expect } from 'vitest';
import type {
  PersonVmAdmissionPermit,
  PersonVmService,
} from '@allrice/person-vm';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import type { GatewayProvider } from './contract.ts';
import { deferred } from './gateway.fixture.ts';

type Host = ReturnType<PersonVmService['createAdmissionHost']>;

export function observeAdmissionCalls(host: Host) {
  const waiting = deferred();
  const canceled = deferred();
  const detaches = new Set<() => void>();
  const waits = new AsyncLocalStorage<{
    permit: PersonVmAdmissionPermit;
    observations: number;
  }>();
  const original = host.participant;
  host.participant = (participant) => {
    const port = original.call(host, participant);
    return {
      ...port,
      observe(binding, signal) {
        const pending = port.observe(binding, signal);
        const frame = waits.getStore();
        if (
          frame &&
          participant === frame.permit.participant &&
          binding === frame.permit.binding &&
          ++frame.observations === 2
        ) {
          // c041 public call sequence: initial subscribe observation, then the
          // first wait check, AFTER its pulse and abort listeners are installed
          // (admission-host.ts 466/499/525-528). No private field or fake wait.
          waiting.resolve();
        }
        return pending;
      },
    };
  };
  function watch(signal: AbortSignal) {
    const abort = () => {
      canceled.resolve();
      detaches.delete(detach);
    };
    const detach = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) canceled.resolve();
    else {
      detaches.add(detach);
      signal.addEventListener('abort', abort, { once: true });
    }
  }
  return {
    waiting,
    canceled,
    watch,
    wait(...args: Parameters<Host['waitUntilReady']>) {
      watch(args[2]); // The actual server-side input, never the client signal.
      return waits.run({ permit: args[1], observations: 0 }, () =>
        host.waitUntilReady(...args),
      );
    },
    dispose() {
      host.participant = original;
      for (const detach of detaches) detach();
      detaches.clear();
      waits.disable();
    },
  };
}

type Stage =
  'queued-fulfilled' | 'active-fulfilled' | 'finish-enter' | 'finish-return';
type Fact = {
  callId: string;
  created: number;
  sent?: number;
  close?: number;
  eof?: number;
};

export function observeNativeLifecycle() {
  const calls = new AsyncLocalStorage<string>();
  const native = new AsyncLocalStorage<string>();
  const permits = new WeakMap<PersonVmAdmissionPermit, string>();
  const requests = new Map<object, Fact>();
  const detaches = new Set<() => void>();
  const snapshots: {
    callId: string;
    stage: Stage;
    at: number;
    facts: Fact[];
  }[] = [];
  let sequence = 0;
  const create = channel('undici:request:create');
  const headers = channel('undici:client:sendHeaders');
  const trailers = channel('undici:request:trailers');
  const onCreate = (message: unknown) => {
    const callId = native.getStore();
    if (callId)
      requests.set((message as { request: object }).request, {
        callId,
        created: ++sequence,
      });
  };
  const onHeaders = (message: unknown) => {
    const { request, socket } = message as { request: object; socket: Socket };
    const fact = requests.get(request);
    if (!fact) return;
    fact.sent = ++sequence;
    const close = () => {
      fact.close = ++sequence;
      detaches.delete(detach);
    };
    const detach = () => socket.off('close', close);
    detaches.add(detach);
    socket.once('close', close); // No destroyed/abort/rejection approximation.
  };
  const onTrailers = (message: unknown) => {
    const fact = requests.get((message as { request: object }).request);
    if (fact) fact.eof = ++sequence;
  };
  create.subscribe(onCreate);
  headers.subscribe(onHeaders);
  trailers.subscribe(onTrailers);
  return {
    runCall<T>(callId: string, operation: () => T): T {
      return calls.run(callId, operation);
    },
    bind(permit: PersonVmAdmissionPermit) {
      const callId = calls.getStore();
      if (callId) permits.set(permit, callId);
    },
    provider(actual: GatewayProvider): GatewayProvider {
      return {
        ...actual,
        stream(...args) {
          const inner = actual.stream(...args)[Symbol.asyncIterator]();
          const callId = args[0].native.callId;
          // Scope the real iterator operations, including return, without an
          // added finally, await or cleanup that could repair an early join.
          const iterator: AsyncIterableIterator<StreamChunk> = {
            [Symbol.asyncIterator]() {
              return this;
            },
            next: (...values) =>
              native.run(callId, () => inner.next(...values)),
          };
          if (inner.return)
            iterator.return = (value) =>
              native.run(callId, () => inner.return!(value));
          if (inner.throw)
            iterator.throw = (error) =>
              native.run(callId, () => inner.throw!(error));
          return iterator;
        },
      };
    },
    mark(permit: PersonVmAdmissionPermit, stage: Stage) {
      const callId = permits.get(permit);
      if (callId)
        snapshots.push({
          callId,
          stage,
          at: ++sequence,
          // Copy NOW; later physical close cannot repair an earlier snapshot.
          facts: [...requests.values()]
            .filter((fact) => fact.callId === callId)
            .map((fact) => ({ ...fact })),
        });
    },
    assertReleased(callId: string, completion: 'close' | 'eof-or-close') {
      const points = snapshots.filter((point) => point.callId === callId);
      expect(points.map((point) => point.stage).sort()).toEqual(
        [
          'queued-fulfilled',
          'active-fulfilled',
          'finish-enter',
          'finish-return',
        ].sort(),
      );
      for (const point of points) {
        expect(
          point.facts,
          `${point.stage}: exact native request`,
        ).toHaveLength(1);
        const fact = point.facts[0]!;
        const completed =
          completion === 'close' ? fact.close : (fact.eof ?? fact.close);
        expect(fact.sent, `${point.stage}: actually dispatched`).toBeDefined();
        expect(fact.created).toBeLessThan(fact.sent!);
        expect(completed, `${point.stage}: local ${completion}`).toBeDefined();
        expect(fact.sent).toBeLessThan(completed!);
        expect(completed).toBeLessThan(point.at);
        if (completion === 'close') expect(fact.eof).toBeUndefined();
      }
      const finish = points.find((point) => point.stage === 'finish-enter')!;
      for (const point of points.filter((point) =>
        point.stage.endsWith('fulfilled'),
      ))
        expect(point.at).toBeLessThan(finish.at);
      expect(finish.at).toBeLessThan(
        points.find((point) => point.stage === 'finish-return')!.at,
      );
    },
    dispose() {
      create.unsubscribe(onCreate);
      headers.unsubscribe(onHeaders);
      trailers.unsubscribe(onTrailers);
      for (const detach of detaches) detach();
      detaches.clear();
      requests.clear();
      calls.disable();
      native.disable();
    },
  };
}

export type NativeLifecycleProof = ReturnType<typeof observeNativeLifecycle>;
