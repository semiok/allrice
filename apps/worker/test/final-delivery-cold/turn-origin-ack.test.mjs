/* global AbortController, process */
import { expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function setup({ emitStart = true, checked = true, onTurn } = {}) {
  let listener,
    barrier,
    modelDispatches = 0;
  const attempted = deferred();
  const sessionId = 'dsh-turn-origin-ack',
    notify = (event) =>
      listener({ method: 'session.event', params: { sessionId, event } });
  const client = {
    subscribe(fn) {
      listener = fn;
      return () => {};
    },
    onFailure: () => () => {},
    interrupt: async () => {},
    async prompt() {
      if (emitStart)
        notify({
          type: 'turn/start',
          seq: 1,
          time: Date.now(),
          data: { turn: 1 },
        });
      attempted.resolve();
      if (barrier) await barrier(); // actual model-prepare/model-dispatch await this closure
      modelDispatches++;
      notify({
        type: 'assistant/message',
        seq: 2,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          message: {
            id: randomUUID(),
            content: [{ type: 'text', text: 'retained answer' }],
            source: { kind: 'model', provider: 'offline', model: 'none' },
            usage: { inputTokens: 2, outputTokens: 1 },
          },
          stream: [],
        },
      });
      listener({
        method: 'session.status',
        params: { sessionId, status: 'idle' },
      });
    },
  };
  const adapter = new DshHarnessAdapter({
    runtimeCommand: process.execPath,
    runtimeArgs: [],
    runtimeRoot: join(tmpdir(), 'allrice-turn-origin-unused'),
  });
  const input = {
    runtime: { client, sessionId },
    prompt: 'never sent to model',
    images: [],
    signal: new AbortController().signal,
    subscription: false,
    onFailureUsage: () => {},
    onTurn: onTurn ?? (async () => {}),
    onDelta: async () => {},
    onNative: async () => {},
    ...(checked
      ? {
          installTurnOriginBarrier(fn) {
            barrier = fn;
          },
        }
      : {}),
  };
  return {
    input,
    client,
    run: () => adapter.runOnce(input),
    attempted,
    get modelDispatches() {
      return modelDispatches;
    },
    get barrier() {
      return barrier;
    },
  };
}
it('actual runOnce blocks preparation/dispatch until turn.started persistence ACK resolves', async () => {
  const ack = deferred(),
    entered = deferred(),
    h = setup({
      onTurn: async (id) => {
        expect(id).toBe('dsh-turn-origin-ack:turn:1');
        entered.resolve();
        await ack.promise;
      },
    }),
    running = h.run();
  await entered.promise;
  await h.attempted.promise;
  expect(h.modelDispatches).toBe(0);
  ack.resolve();
  await expect(running).resolves.toMatchObject({ answer: 'retained answer' });
  expect(h.modelDispatches).toBe(1);
  // Retained through native retry/owned-child join after runOnce unsubscribes.
  await expect(h.barrier()).resolves.toBeUndefined();
});
it('persistence failure refuses admission and does not turn a native start into a fake ACK', async () => {
  const failure = Error('turn.started SQL ACK failed'),
    h = setup({
      onTurn: async () => {
        throw failure;
      },
    });
  await expect(h.run()).rejects.toBe(failure);
  expect(h.modelDispatches).toBe(0);
});
it('covered dispatch without any actual turn/start fails closed before sending', async () => {
  const h = setup({ emitStart: false });
  await expect(h.run()).rejects.toMatchObject({
    code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    retryable: false,
  });
  expect(h.modelDispatches).toBe(0);
});
it('legacy runOnce keeps the existing continuation lifecycle without the new ACK gate', async () => {
  const ack = deferred(),
    entered = deferred(),
    h = setup({
      checked: false,
      onTurn: async () => {
        entered.resolve();
        await ack.promise;
      },
    }),
    running = h.run();
  await entered.promise;
  expect(h.modelDispatches).toBe(1);
  ack.resolve();
  await expect(running).resolves.toMatchObject({ answer: 'retained answer' });
});
