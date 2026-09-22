import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createGovernedAssistantNativeRuntime } from '../../dsh/allrice-assistant-runtime.mjs';

// The pinned native notification/output selector, not a reimplementation of
// their behavior. No provider, session persistence, database, or personal data.
const require = createRequire(import.meta.url);
const nativeRoot = dirname(
  require.resolve('@deepseek-ai/dsh-subagent/package.json'),
);
const { SubagentContinuationManager } = await import(
  pathToFileURL(join(nativeRoot, 'lib/types/continuation.js')).href
);
const { finalAssistantOutput } = await import(
  pathToFileURL(join(nativeRoot, 'lib/types/assistant-output.js')).href
);
const storedResult = {
  deliveryId: 'b4f9f726-f4e0-499d-8331-ed88767dfe09',
  status: 'partial',
  summary: 'DURABLE_REPORT_SENTINEL',
  evidence: [
    {
      id: '88b3014f-d61b-40bb-87b6-3fc6fa13a1c1',
      digest: `sha256:${'a'.repeat(64)}`,
    },
  ],
  incomplete: ['Platform usage has not settled.'],
  usageComplete: false,
  wakeParent: true,
};

function fixture(result = storedResult) {
  const agents = new Map(),
    listeners = new Map();
  const parent = {
    id: 'synthetic-parent',
    status: 'idle',
    session: { header: {}, events: [] },
    ctx: { tools: { restrict: vi.fn() } },
    followup: vi.fn((message) => message.id),
    steer: vi.fn((message) => message.id),
    inject: vi.fn((message) => message.id),
    whenIdle: async () => {},
  };
  const originalFollowup = parent.followup;
  const originals = {
    followup: parent.followup,
    steer: parent.steer,
    inject: parent.inject,
  };
  agents.set(parent.id, parent);
  const bridge = vi.fn(async (method) => {
    if (method === 'settled') return result;
    if (method === 'adopt-result') return { adopted: true };
    throw Error(`unexpected bridge call: ${method}`);
  });
  const ctx = {
    on: (name, listener) => listeners.set(name, listener),
    agents,
    sessions: { flush: async () => {} },
    tools: { guard: vi.fn(), register: vi.fn() },
    logger: { warn: vi.fn() },
  };
  const runtime = createGovernedAssistantNativeRuntime(ctx, bridge);
  runtime.bind({ nativeSessionId: parent.id });
  runtime.bind({
    nativeSessionId: 'synthetic-child',
    parentNativeSessionId: parent.id,
  });
  const manager = Object.assign(
    Object.create(SubagentContinuationManager.prototype),
    {
      ctx,
      activations: new Map(),
      closingScopes: new Map(),
      draining: false,
    },
  );
  const nativeOutput = finalAssistantOutput([
    {
      type: 'assistant/message',
      data: {
        message: {
          content: [
            {
              type: 'tool-call',
              id: 'report-call',
              name: 'assistant_report',
              arguments: JSON.stringify({
                status: 'completed',
                summary: 'UNTRUSTED_CHILD_TOOL_ARGUMENTS',
              }),
            },
          ],
        },
      },
    },
    {
      type: 'user/message',
      data: {
        content: [
          {
            type: 'tool-result',
            toolCallId: 'report-call',
            content: [{ type: 'text', text: JSON.stringify(result) }],
          },
        ],
      },
    },
  ]);
  const notify = (childId = 'synthetic-child', output = nativeOutput) =>
    manager.notifySettlement(
      { announced: true, childId, parentSession: parent.id },
      { stopReason: 'completed', output },
    );
  return {
    runtime,
    parent,
    originalFollowup,
    bridge,
    notify,
    nativeOutput,
    agents,
    listeners,
    ctx,
    originals,
  };
}

describe('governed native parent report delivery', () => {
  it('does not yield on a rejected or replayed development delegation', async () => {
    const f = fixture();
    f.agents.requireInitiator = () => f.parent;
    const tool = f.ctx.tools.register.mock.calls
      .map(([value]) => value)
      .find((value) => value.name === 'assistant_delegate');
    for (const result of [
      { error: 'development_delegate_invalid' },
      { dispatch: false, created: false },
    ]) {
      f.bridge.mockResolvedValue(result);
      const exec = {
        callId: 'development-delegation',
        signal: new globalThis.AbortController().signal,
        concludeTurn: vi.fn(),
      };
      await tool.execute(
        {
          label: 'edit',
          text: 'Scoped proposal.',
          tools: ['assistant.development', 'assistant.report'],
          development: '{}',
        },
        exec,
      );
      expect(exec.concludeTurn).not.toHaveBeenCalled();
    }
  });
  it('keeps the child turn open for correctable report validation errors', async () => {
    const f = fixture();
    f.agents.requireInitiator = () => ({ id: 'synthetic-child' });
    f.bridge.mockResolvedValue({
      error: 'assistant_report_delivery_required',
      message: 'Provide a deliverable.',
    });
    const tool = f.ctx.tools.register.mock.calls
      .map(([value]) => value)
      .find((value) => value.name === 'assistant_report');
    const exec = {
      callId: 'invalid-report',
      signal: new globalThis.AbortController().signal,
      concludeTurn: vi.fn(),
    };
    const result = await tool.execute(
      { status: 'completed', summary: '42', evidence: [], incomplete: [] },
      exec,
    );
    expect(result.content).toContain('assistant_report_delivery_required');
    expect(exec.concludeTurn).not.toHaveBeenCalled();
  });
  it('report concludes the child but only native settlement delivers the current platform report', async () => {
    const f = fixture();
    f.agents.requireInitiator = () => ({ id: 'synthetic-child' });
    f.bridge.mockImplementation(async (method) => {
      if (method === 'report' || method === 'settled') return storedResult;
      throw Error('unexpected bridge call');
    });
    const tool = f.ctx.tools.register.mock.calls
      .map(([value]) => value)
      .find((value) => value.name === 'assistant_report');
    const exec = {
      callId: 'synthetic-report-call',
      signal: new globalThis.AbortController().signal,
      concludeTurn: vi.fn(),
    };
    const result = await tool.execute(
      {
        status: 'completed',
        summary: 'raw child claim',
        evidence: [],
        incomplete: [],
      },
      exec,
    );
    expect(JSON.parse(result.content).status).toBe('partial');
    expect(exec.concludeTurn).toHaveBeenCalledTimes(1);
    expect(f.originalFollowup).not.toHaveBeenCalled();
    f.notify();
    await f.runtime.flush();
    expect(f.originalFollowup).toHaveBeenCalledTimes(1);
    expect(f.originalFollowup.mock.calls[0][0].content[0].text).toContain(
      storedResult.summary,
    );
  });

  it.each(['followup', 'steer', 'inject'])(
    'keeps the native %s scheduling method',
    async (method) => {
      const f = fixture();
      f.parent[method]({
        id: `native-${method}`,
        content: [],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          senderSessionId: 'synthetic-child',
        },
      });
      await f.runtime.flush();
      expect(f.originals[method]).toHaveBeenCalledTimes(1);
      for (const other of Object.keys(f.originals).filter(
        (key) => key !== method,
      ))
        expect(f.originals[other]).not.toHaveBeenCalled();
    },
  );
  it('renders the durable platform report in the real native settled notice', async () => {
    const f = fixture();
    f.notify();
    await f.runtime.flush();
    expect(f.originalFollowup).toHaveBeenCalledTimes(1);
    const [message] = f.originalFollowup.mock.calls[0];
    expect(message.source).toMatchObject({
      kind: 'subagent-settled',
      form: 'notice',
      senderSessionId: 'synthetic-child',
    });
    // The pinned provider's user-role conversion exposes text, not tool calls.
    const visible = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    expect(visible).toContain(storedResult.summary);
    expect(visible).toContain(storedResult.deliveryId);
    expect(visible).toContain(storedResult.evidence[0].digest);
    expect(visible).toContain('"status":"partial"');
    expect(visible).toContain('"usageComplete":false');
    expect(visible).not.toContain('UNTRUSTED_CHILD_TOOL_ARGUMENTS');
  });

  it('does not forward synthetic closing reasoning or child tool-call arguments', async () => {
    const f = fixture();
    f.notify('synthetic-child', [
      { type: 'reasoning', text: 'SYNTHETIC_NONPUBLIC_SENTINEL' },
      { type: 'text', text: 'UNVERIFIED_CLOSING_TEXT' },
    ]);
    await f.runtime.flush();
    const [message] = f.originalFollowup.mock.calls[0];
    expect(message.content.every((block) => block.type === 'text')).toBe(true);
    expect(JSON.stringify(message)).not.toContain(
      'SYNTHETIC_NONPUBLIC_SENTINEL',
    );
    expect(JSON.stringify(message)).not.toContain('UNVERIFIED_CLOSING_TEXT');
  });

  it('preserves the native message id and source without mutating the notice', async () => {
    const f = fixture();
    const message = {
      id: 'native-message-id',
      role: 'user',
      content: [{ type: 'text', text: 'native closing' }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        senderSessionId: 'synthetic-child',
        summary: 'native summary',
      },
    };
    const before = JSON.stringify(message);
    expect(f.parent.followup(message)).toBe(message.id);
    await f.runtime.flush();
    const [received] = f.originalFollowup.mock.calls[0];
    expect(received.id).toBe(message.id);
    expect(received.source).toBe(message.source);
    expect(JSON.stringify(message)).toBe(before);
  });

  it('deduplicates concurrent and later settlement notices for one durable delivery', async () => {
    const f = fixture();
    f.notify();
    f.notify();
    await f.runtime.flush();
    f.notify();
    await f.runtime.flush();
    expect(f.originalFollowup).toHaveBeenCalledTimes(1);
    // Dedupe does not bypass the current platform permission check.
    expect(
      f.bridge.mock.calls.filter(([method]) => method === 'settled'),
    ).toHaveLength(3);
  });

  it.each([false, undefined, 'true'])(
    'does not wake or adopt without explicit current authority (%j)',
    async (wakeParent) => {
      const f = fixture({ ...storedResult, wakeParent });
      f.notify();
      await f.runtime.flush();
      expect(f.originalFollowup).not.toHaveBeenCalled();
      await f.runtime.join({ nativeSessionId: f.parent.id });
      expect(
        f.bridge.mock.calls.some(([method]) => method === 'adopt-result'),
      ).toBe(false);
    },
  );

  it('does not deliver to a disposed/replaced parent', async () => {
    const f = fixture();
    f.notify();
    f.agents.delete(f.parent.id);
    await f.runtime.flush();
    expect(f.originalFollowup).not.toHaveBeenCalled();
  });

  it.each([
    {
      source: {
        kind: 'subagent-settled',
        form: 'relay',
        senderSessionId: 'synthetic-child',
      },
    },
    { id: '' },
    {
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        senderSessionId: 'unbound-child',
      },
    },
    {
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        senderSessionId: 'other-parent-child',
      },
    },
  ])(
    'rejects invalid native provenance before permission lookup (%j)',
    async (patch) => {
      const f = fixture();
      f.runtime.bind({
        nativeSessionId: 'other-parent-child',
        parentNativeSessionId: 'different-parent',
      });
      expect(() =>
        f.parent.followup({
          id: 'native-id',
          content: [],
          source: {
            kind: 'subagent-settled',
            form: 'notice',
            senderSessionId: 'synthetic-child',
          },
          ...patch,
        }),
      ).toThrow(/assistant_settlement_/);
      await f.runtime.flush();
      expect(f.originalFollowup).not.toHaveBeenCalled();
      expect(f.bridge).not.toHaveBeenCalled();
    },
  );

  it.each([
    { deliveryId: 'invalid' },
    { summary: 'x'.repeat(16001) },
    { incomplete: ['x'.repeat(2001)] },
    { evidence: [{ id: 'invalid', digest: 'invalid' }] },
    { status: 'invented' },
    { usageComplete: 'true' },
  ])(
    'fails closed on a malformed or oversized durable report (%j)',
    async (patch) => {
      const f = fixture({ ...storedResult, ...patch });
      f.notify();
      await expect(f.runtime.flush()).rejects.toThrow(
        'assistant_settlement_result_invalid',
      );
      expect(f.originalFollowup).not.toHaveBeenCalled();
    },
  );

  it('keeps all existing maximum-size report fields as valid JSON, never truncation', async () => {
    const result = {
      ...storedResult,
      summary: '界'.repeat(16000),
      incomplete: Array.from({ length: 32 }, () => '\\'.repeat(2000)),
      evidence: Array.from({ length: 32 }, () => storedResult.evidence[0]),
    };
    const f = fixture(result);
    f.notify();
    await f.runtime.flush();
    const text = f.originalFollowup.mock.calls[0][0].content[0].text;
    const visible = JSON.parse(text.slice(text.indexOf('\n') + 1));
    const { wakeParent, ...expected } = result;
    void wakeParent;
    expect(visible).toEqual(expected);
  });

  it('adopts only the exact governed message actually sent to this parent', async () => {
    const f = fixture();
    f.notify();
    await f.runtime.flush();
    const [message] = f.originalFollowup.mock.calls[0];
    f.parent.session.events.push({
      type: 'user/message',
      seq: 1,
      data: { ...message, id: 'unrelated-native-notice' },
    });
    await f.runtime.join({ nativeSessionId: f.parent.id });
    expect(
      f.bridge.mock.calls.some(([method]) => method === 'adopt-result'),
    ).toBe(false);
    f.parent.session.events.push({
      type: 'user/message',
      seq: 2,
      data: message,
    });
    await f.runtime.join({ nativeSessionId: f.parent.id });
    expect(f.bridge).toHaveBeenCalledWith(
      'adopt-result',
      {
        nativeSessionId: f.parent.id,
        deliveryId: storedResult.deliveryId,
        nativeMessageId: message.id,
        adoptedSeq: 2,
      },
      expect.anything(),
    );
  });

  it('preserves independent reports and adoptions from multiple children', async () => {
    const f = fixture();
    const second = {
      ...storedResult,
      deliveryId: 'b5f9f726-f4e0-499d-8331-ed88767dfe09',
      summary: 'SECOND_CHILD_REPORT',
    };
    f.runtime.bind({
      nativeSessionId: 'synthetic-second-child',
      parentNativeSessionId: f.parent.id,
    });
    f.notify();
    await f.runtime.flush();
    f.bridge.mockImplementation(async (method) =>
      method === 'settled' ? second : { adopted: true },
    );
    f.notify('synthetic-second-child');
    await f.runtime.flush();
    expect(f.originalFollowup).toHaveBeenCalledTimes(2);
    for (const [index, [message]] of f.originalFollowup.mock.calls.entries())
      f.parent.session.events.push({
        type: 'user/message',
        seq: index + 1,
        data: message,
      });
    await f.runtime.join({ nativeSessionId: f.parent.id });
    expect(
      f.bridge.mock.calls
        .filter(([method]) => method === 'adopt-result')
        .map(([, p]) => p.deliveryId),
    ).toEqual([storedResult.deliveryId, second.deliveryId]);
    expect(f.originalFollowup.mock.calls[1][0].content[0].text).toContain(
      second.summary,
    );
  });

  it('refuses a durable delivery ID reused for a different child', async () => {
    const f = fixture();
    f.runtime.bind({
      nativeSessionId: 'synthetic-second-child',
      parentNativeSessionId: f.parent.id,
    });
    f.notify();
    await f.runtime.flush();
    f.notify('synthetic-second-child');
    await expect(f.runtime.flush()).rejects.toThrow(
      'assistant_settlement_delivery_mismatch',
    );
    expect(f.originalFollowup).toHaveBeenCalledTimes(1);
  });
});
