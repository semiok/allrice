import { describe, expect, it, vi } from 'vitest';
import { createGovernedAssistantNativeRuntime } from '../../dsh/allrice-assistant-runtime.mjs';

/** Unit seam only. Actual DSH/Google HTTP/PG rejection is separately covered by
 * assistant-gemini-production.integration.test.ts. No model or database here. */
function fixture(settle = async () => ({ settled: true })) {
  const listeners = new Map();
  const agent = {
    id: 'synthetic-native-id',
    session: { header: {}, events: [] },
    ctx: { tools: { restrict: vi.fn() } },
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
  };
  const bridge = vi.fn(async (method, params) => {
    if (method === 'model-prepare')
      return { prepared: true, outputTokens: 3754 };
    if (method === 'model-dispatch')
      return { reserved: true, outputTokens: params.outputTokens };
    if (method === 'model-settle') return settle(params);
    throw Error('unexpected_synthetic_bridge_call');
  });
  const runtime = createGovernedAssistantNativeRuntime(
    {
      on: (event, listener) => listeners.set(event, listener),
      agents: { get: (id) => (id === agent.id ? agent : undefined) },
      sessions: { flush: async () => {} },
      tools: { guard: vi.fn(), register: vi.fn() },
    },
    bridge,
  );
  runtime.bind({ nativeSessionId: agent.id, wireTools: [] });
  const signal = new globalThis.AbortController().signal;
  const prepare = () =>
    listeners.get('agent/request')({ agent, signal }, async () => ({
      maxTokens: 4000,
    }));
  const execute = async (usage, fail = false) => {
    const stream = listeners.get('llm/stream')(
      {
        sessionId: agent.id,
        provider: 'google',
        model: 'gemini-3.8-flash',
        maxTokens: 3754,
        messages: [],
        signal,
      },
      async function* () {
        if (usage !== undefined) yield { type: 'usage', usage };
        if (fail) throw Error('synthetic_provider_503');
      },
    );
    for await (const chunk of stream) void chunk;
  };
  return { bridge, prepare, execute };
}

describe('governed native model admission recovery', () => {
  it.each([
    undefined,
    { inputTokens: 20 },
    { outputTokens: 5 },
    { inputTokens: 0, outputTokens: 0 },
  ])(
    'retains unknown admission and refuses a second prepare/dispatch (%j)',
    async (usage) => {
      const f = fixture();
      await expect(f.prepare()).resolves.toEqual({ maxTokens: 3754 });
      await expect(f.execute(usage, true)).rejects.toThrow(
        'synthetic_provider_503',
      );
      await expect(f.prepare()).rejects.toThrow(
        'assistant_model_unknown_no_replay',
      );
      expect(f.bridge.mock.calls.map(([method]) => method)).toEqual([
        'model-prepare',
        'model-dispatch',
        'model-settle',
      ]);
    },
  );

  it('a failed settlement RPC cannot release even complete usage for replay', async () => {
    const f = fixture(async () => {
      throw Error('synthetic_settle_ack_lost');
    });
    await f.prepare();
    await expect(
      f.execute({ inputTokens: 20, outputTokens: 5 }),
    ).rejects.toThrow('synthetic_settle_ack_lost');
    await expect(f.prepare()).rejects.toThrow(
      'assistant_model_unknown_no_replay',
    );
    expect(
      f.bridge.mock.calls.filter(([method]) => method === 'model-prepare'),
    ).toHaveLength(1);
  });

  it('an unconfirmed settlement reply cannot authorize another model call', async () => {
    const f = fixture(async () => ({ settled: false }));
    await f.prepare();
    await f.execute({ inputTokens: 20, outputTokens: 5 });
    await expect(f.prepare()).rejects.toThrow(
      'assistant_model_unknown_no_replay',
    );
  });

  it('complete settled usage releases the guard for a distinct next normal call', async () => {
    const f = fixture();
    await f.prepare();
    await f.execute({ inputTokens: 16, cacheReadTokens: 4, outputTokens: 7 });
    await expect(f.prepare()).resolves.toEqual({ maxTokens: 3754 });
    await f.execute({ inputTokens: 21, outputTokens: 0 });
    const calls = f.bridge.mock.calls.filter(
      ([method]) => method === 'model-prepare',
    );
    expect(calls).toHaveLength(2);
    expect(calls[0][1].callId).not.toBe(calls[1][1].callId);
    const dispatches = f.bridge.mock.calls.filter(
      ([method]) => method === 'model-dispatch',
    );
    const settlements = f.bridge.mock.calls.filter(
      ([method]) => method === 'model-settle',
    );
    for (const [, settlement] of settlements) {
      expect(settlement.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(settlement.requestDigest).toBe(
        dispatches.find(([, p]) => p.callId === settlement.callId)[1]
          .requestDigest,
      );
      expect(settlement).not.toHaveProperty('messages');
    }
    expect(
      f.bridge.mock.calls
        .filter(([method]) => method === 'model-settle')
        .map(([, p]) => [p.inputTokens, p.outputTokens]),
    ).toEqual([
      [20, 7],
      [21, 0],
    ]);
  });
});
