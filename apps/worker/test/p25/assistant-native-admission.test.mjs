import { describe, expect, it, vi } from 'vitest';
import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { createGovernedAssistantNativeRuntime } from '../../dsh/allrice-assistant-runtime.mjs';

/** Unit seam only. Actual DSH/Google HTTP/PG rejection is separately covered by
 * assistant-gemini-production.integration.test.ts. No model or database here. */
function fixture(settle = async () => ({ settled: true })) {
  const listeners = new Map();
  const agent = {
    id: 'synthetic-native-id',
    session: {
      header: {},
      events: [],
      snapshotEvents() {
        return [...this.events];
      },
    },
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
  const execute = async (usage, fail = false, finish) => {
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
        if (finish) yield { type: 'finish', reason: finish };
        if (fail) throw fail === true ? Error('synthetic_provider_503') : fail;
      },
    );
    for await (const chunk of stream) void chunk;
  };
  return {
    bridge,
    prepare,
    execute,
    runtime,
    diagnostics: () => runtime.diagnostics({ nativeSessionId: agent.id }),
    finish: () => runtime.finish({ nativeSessionId: agent.id }),
  };
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

describe('bounded native assistant failure diagnostics', () => {
  it('normalizes the pinned provider QUOTA wire code without reading its message', async () => {
    const f = fixture();
    await f.prepare();
    await f.execute(undefined, false, {
      kind: 'error',
      failure: { code: QUOTA_EXCEEDED_CODE },
    });
    expect(f.diagnostics().failures[0].code).toBe('QUOTA_EXCEEDED');
    await expect(f.prepare()).rejects.toThrow(
      'assistant_model_unknown_no_replay',
    );
  });
  it('captures provider finish errors with unknown usage before no-replay masks them', async () => {
    const f = fixture();
    await f.prepare();
    await f.execute({ inputTokens: 0, outputTokens: 0 }, false, {
      kind: 'error',
      failure: { code: 'SERVER', message: 'private-provider-body' },
    });
    await expect(f.prepare()).rejects.toThrow(
      'assistant_model_unknown_no_replay',
    );
    const proof = f.diagnostics();
    expect(proof).toMatchObject({
      version: 1,
      truncated: false,
      failures: [
        {
          nativeSessionId: 'synthetic-native-id',
          phase: 'finish',
          code: 'SERVER',
          stopKind: 'error',
          inputUsageKnown: false,
          outputUsageKnown: false,
          settlementConfirmed: true,
        },
      ],
    });
    expect(proof.failures[0].callId).toBe(f.bridge.mock.calls[0][1].callId);
    expect(JSON.stringify(proof)).not.toContain('private-provider-body');
    expect(
      f.bridge.mock.calls.filter(([method]) => method === 'model-dispatch'),
    ).toHaveLength(1);
  });

  it.each([
    [{ inputTokens: 10 }, true, false],
    [{ outputTokens: 2 }, false, true],
    [undefined, false, false],
  ])(
    'distinguishes incomplete dimensions without making them zero (%j)',
    async (usage, input, output) => {
      const f = fixture();
      await f.prepare();
      await f.execute(usage, false, { kind: 'stop' });
      expect(f.diagnostics().failures).toMatchObject([
        {
          phase: 'usage',
          code: 'USAGE_INCOMPLETE',
          stopKind: 'stop',
          inputUsageKnown: input,
          outputUsageKnown: output,
          settlementConfirmed: true,
        },
      ]);
      await expect(f.prepare()).rejects.toThrow(
        'assistant_model_unknown_no_replay',
      );
    },
  );

  it('preserves the first thrown error and records secondary settlement failure', async () => {
    const f = fixture(async () => {
      throw Error('private-settlement-failure');
    });
    const original = Object.assign(Error('private-stream-failure'), {
      code: 'TRANSPORT',
    });
    await f.prepare();
    await expect(
      f.execute({ inputTokens: 3, outputTokens: 2 }, original),
    ).rejects.toBe(original);
    expect(f.diagnostics().failures).toMatchObject([
      {
        phase: 'stream',
        code: 'TRANSPORT',
        inputUsageKnown: true,
        outputUsageKnown: true,
        settlementConfirmed: false,
        settlementFailureCode: 'SETTLEMENT_FAILED',
      },
    ]);
    expect(JSON.stringify(f.diagnostics())).not.toContain('private-');
    await expect(f.prepare()).rejects.toThrow(
      'assistant_model_unknown_no_replay',
    );
  });

  it.each([false, 'throw'])(
    'a settlement failure is not confused with missing usage (%j)',
    async (mode) => {
      const f = fixture(async () => {
        if (mode === 'throw') throw Error('private-ack-error');
        return { settled: false };
      });
      await f.prepare();
      const call = f.execute({ inputTokens: 3, outputTokens: 2 });
      if (mode === 'throw')
        await expect(call).rejects.toThrow('private-ack-error');
      else await call;
      expect(f.diagnostics().failures).toMatchObject([
        {
          phase: 'settlement',
          code: mode === 'throw' ? 'SETTLEMENT_FAILED' : 'SETTLEMENT_REJECTED',
          inputUsageKnown: true,
          outputUsageKnown: true,
          settlementConfirmed: false,
        },
      ]);
    },
  );

  it('records max-tokens separately from unknown usage, without denying a settled next call', async () => {
    const f = fixture();
    await f.prepare();
    await f.execute({ inputTokens: 10, outputTokens: 3754 }, false, {
      kind: 'max-tokens',
    });
    expect(f.diagnostics().failures).toMatchObject([
      {
        phase: 'finish',
        code: 'MAX_TOKENS',
        stopKind: 'max-tokens',
        inputUsageKnown: true,
        outputUsageKnown: true,
        settlementConfirmed: true,
      },
    ]);
    await expect(f.prepare()).resolves.toEqual({ maxTokens: 3754 });
  });

  it('ignores untrusted codes, getters, coercion and proxies', async () => {
    const trap = vi.fn(() => {
      throw Error('private-trap-must-not-run');
    });
    for (const reason of [
      {
        kind: 'error',
        failure: { code: 'secret-key', message: 'secret-key', toJSON: trap },
      },
      {
        kind: 'error',
        failure: Object.defineProperty({}, 'code', { get: trap }),
      },
      {
        kind: 'error',
        failure: new Proxy({}, { getOwnPropertyDescriptor: trap, get: trap }),
      },
      Object.defineProperty({}, 'kind', { get: trap }),
      new Proxy({}, { getOwnPropertyDescriptor: trap, get: trap }),
    ]) {
      const f = fixture();
      await f.prepare();
      await f.execute(undefined, false, reason);
      expect(JSON.stringify(f.diagnostics())).not.toMatch(
        /secret-key|private-trap/,
      );
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it('bounds stored failures, returns snapshots and clears them with Run authority', async () => {
    const f = fixture();
    for (let i = 0; i < 66; i++) {
      await f.prepare();
      await f.execute({ inputTokens: 4, outputTokens: 3 }, false, {
        kind: 'max-tokens',
      });
    }
    const proof = f.diagnostics();
    expect(proof.failures).toHaveLength(64);
    expect(proof.truncated).toBe(true);
    proof.failures[0].code = 'mutated';
    expect(f.diagnostics().failures[0].code).toBe('MAX_TOKENS');
    await f.finish();
    expect(() => f.diagnostics()).toThrow('assistant_native_unbound');
    f.runtime.bind({ nativeSessionId: 'synthetic-native-id', wireTools: [] });
    expect(f.diagnostics()).toEqual({
      version: 1,
      failures: [],
      truncated: false,
    });
  });

  it('does not expose another root or allow a child to inspect the whole tree', async () => {
    const f = fixture();
    await f.prepare();
    await f.execute(undefined);
    f.runtime.bind({ nativeSessionId: 'other-native-root', wireTools: [] });
    expect(
      f.runtime.diagnostics({ nativeSessionId: 'other-native-root' }).failures,
    ).toEqual([]);
    f.runtime.bind({
      nativeSessionId: 'child-native-id',
      parentNativeSessionId: 'synthetic-native-id',
    });
    expect(() =>
      f.runtime.diagnostics({ nativeSessionId: 'child-native-id' }),
    ).toThrow('assistant_root_required');
    expect(() => f.runtime.diagnostics({ nativeSessionId: 'unbound' })).toThrow(
      'assistant_native_unbound',
    );
  });
});
