/* global AbortController */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  createGovernedAssistantNativeRuntime,
  assertAssistantBusinessInputOpen,
  runAssistantBusinessInput,
} from './allrice-assistant-runtime.mjs';

function fixture(override = {}) {
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } }];
  const agent = {
    id: 'native-input-fixture',
    status: 'running',
    inbox: { nextStep: [], nextTurn: [] },
    session: { snapshotEvents: () => events },
    ctx: { tools: {} },
    send() {},
    followup() {},
    steer() {},
    inject() {},
  };
  const ctx = {
    on() {
      return () => {};
    },
    tools: { guard() {} },
    agents: { get: (id) => (id === agent.id ? agent : undefined) },
  };
  const calls = [];
  const runtime = createGovernedAssistantNativeRuntime(
    ctx,
    async (action, scope, signal) => {
      calls.push(action);
      if (override[action]) return override[action](scope, signal);
      return {
        [action === 'input-gate-pause' ? 'paused' : 'released']: true,
        gateId: scope.gateId,
        turnId: scope.turnId,
      };
    },
    { controlTools: [] },
  );
  runtime.bind({ nativeSessionId: agent.id, runId: 'fixture-run' });
  const input = {
    nativeSessionId: agent.id,
    turn: 1,
    signal: new AbortController().signal,
  };
  return {
    runtime,
    input,
    agent,
    events,
    calls,
    guard: () =>
      assertAssistantBusinessInputOpen(runtime, 'session/steer', {
        sessionId: agent.id,
        inputDelivery: false,
      }),
  };
}

test('pause ACK mismatch cannot grant a handle; cleanup takes a real release ACK', async () => {
  const h = fixture({
    'input-gate-pause': async () => ({
      paused: true,
      gateId: 'wrong',
      turnId: 'wrong',
    }),
  });
  await assert.rejects(
    h.runtime.acquireInputDelivery(h.input),
    /INPUT_GATE_PAUSE_UNKNOWN/,
  );
  assert.deepEqual(h.calls, ['input-gate-pause', 'input-gate-release']);
  assert.doesNotThrow(h.guard);
});

test.each(['session/steer', 'session/question-reply'])(
  'a still-running %s handler blocks pause even after its caller stops waiting',
  async (method) => {
    const h = fixture();
    let settle;
    const work = runAssistantBusinessInput(
      h.runtime,
      method,
      { sessionId: h.agent.id },
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    await assert.rejects(
      h.runtime.acquireInputDelivery(h.input),
      /INPUT_GATE_NOT_QUIESCENT/,
    );
    assert.deepEqual(h.calls, []);
    settle({ genuinelyFinished: true });
    await work;
    const held = await h.runtime.acquireInputDelivery(h.input);
    await held.releaseBeforeTurnClose();
    assert.doesNotThrow(h.guard);
  },
);

test('external boolean cannot bypass the short window; internal preparation and other roots stay open', async () => {
  const h = fixture();
  const held = await h.runtime.acquireInputDelivery(h.input);
  assert.equal(held.stillCurrent(), true);
  assert.throws(h.guard, /ASSISTANT_COMPLETING/);
  assert.throws(
    () =>
      assertAssistantBusinessInputOpen(h.runtime, 'session/question-reply', {
        sessionId: h.agent.id,
      }),
    /ASSISTANT_COMPLETING/,
  );
  assert.doesNotThrow(() =>
    h.runtime.assertBusinessInputOpen({ nativeSessionId: h.agent.id }),
  );
  assert.doesNotThrow(() =>
    assertAssistantBusinessInputOpen(h.runtime, 'session/steer', {
      sessionId: 'historical-other-root',
    }),
  );
  await held.releaseBeforeTurnClose();
  assert.equal(held.stillCurrent(), false);
  assert.doesNotThrow(h.guard);
});

test('failed release restores business ingress but never claims completion or retries an unknown ACK', async () => {
  const h = fixture({
    'input-gate-release': async () => ({
      released: true,
      gateId: 'wrong',
      turnId: 'wrong',
    }),
  });
  const held = await h.runtime.acquireInputDelivery(h.input);
  await assert.rejects(
    held.releaseBeforeTurnClose(),
    /INPUT_GATE_RELEASE_UNKNOWN/,
  );
  await assert.rejects(
    held.releaseBeforeTurnClose(),
    /INPUT_GATE_RELEASE_UNKNOWN/,
  );
  assert.equal(
    h.calls.filter((action) => action === 'input-gate-release').length,
    1,
  );
  assert.doesNotThrow(h.guard);
  await assert.rejects(
    h.runtime.joinForFinalDelivery({ nativeSessionId: h.agent.id }),
    /INPUT_GATE_NOT_RELEASED/,
  );
});

test('turn change during drain cannot grant the old scope', async () => {
  let h;
  h = fixture({
    'input-gate-pause': async (scope) => {
      h.events.push({ seq: 1, type: 'turn/start', data: { turn: 2 } });
      return { paused: true, gateId: scope.gateId, turnId: scope.turnId };
    },
  });
  await assert.rejects(
    h.runtime.acquireInputDelivery(h.input),
    /INPUT_GATE_NOT_QUIESCENT/,
  );
  assert.deepEqual(h.calls, ['input-gate-pause', 'input-gate-release']);
  assert.doesNotThrow(h.guard);
});

test('cancellation during pause releases through the same private token and returns no handle', async () => {
  const h = fixture({
    'input-gate-pause': async (_scope, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(Error('original-signal-aborted')),
          { once: true },
        );
      }),
  });
  const abort = new AbortController();
  const acquisition = h.runtime.acquireInputDelivery({
    ...h.input,
    signal: abort.signal,
  });
  const refused = assert.rejects(acquisition, /original-signal-aborted/);
  abort.abort();
  await refused;
  assert.deepEqual(h.calls, ['input-gate-pause', 'input-gate-release']);
  assert.doesNotThrow(h.guard);
});
