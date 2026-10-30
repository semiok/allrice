import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { gate, host, text } from '../test/native-subagent/fixture.mjs';
import { projectNativeUsage } from '../src/harness/dsh/native-usage.ts';

const usage = {
  inputTokens: 1000,
  cacheReadTokens: 2000,
  cacheWriteTokens: 500,
  outputTokens: 100,
};
const options = (h, signal) => ({
  sessionId: h.root.id,
  provider: 'pr0-synthetic',
  model: 'fixed',
  messages: [],
  signal,
});
async function consume(stream) {
  for await (const _chunk of stream) {
    void _chunk;
  }
}
function recorder(receipts, hook = async () => {}) {
  return async (method, params, signal) => {
    if (method === 'allrice/model-receipt') {
      await hook(params, signal);
      receipts.push(globalThis.structuredClone(params));
      return {};
    }
    if (method === 'allrice/run-authorize') {
      signal?.throwIfAborted();
      return { allowed: true };
    }
    throw Error(`unexpected accounting bridge ${method}`);
  };
}
it('waits for actual start delivery then rechecks native permission before provider dispatch', async () => {
  const entered = gate(),
    release = gate(),
    receipts = [],
    abort = new globalThis.AbortController();
  const h = await host({
    accounting: true,
    runId: randomUUID(),
    usage,
    bridge: recorder(receipts, async (p) => {
      if (p.fact?.phase === 'start') {
        entered.resolve();
        await release.promise;
      }
    }),
  });
  const consuming = consume(h.ctx.llm.stream(options(h, abort.signal))).catch(
    (error) => error,
  );
  await entered.promise;
  abort.abort(Error('user stopped before model authorization'));
  release.resolve();
  await consuming;
  await h.server.handleRequest('run/end', {
    runId: h.server.runAdmission.attribute({ nativeSessionId: h.root.id })
      .runId,
  });
  expect(h.calls).toHaveLength(0);
  expect(receipts.filter((p) => p.fact?.phase === 'start')).toHaveLength(1);
  expect(
    receipts.find((p) => p.fact?.phase === 'finish').fact.usageComplete,
  ).toBe(false);
});
it.each(['start', 'finish'])(
  'does not retry the provider when %s delivery fails',
  async (phase) => {
    const receipts = [];
    const h = await host({
      accounting: true,
      runId: randomUUID(),
      usage,
      bridge: recorder(receipts, async (p) => {
        if (p.fact?.phase === phase) throw Error('isolated receipt failure');
      }),
    });
    await h.prompt('只回答一次；账本失败不要重新执行。');
    await h.wait();
    await h.server.nativeAccounting.flush();
    expect(h.calls).toHaveLength(1);
    expect(receipts.at(-1).delivery).toEqual({ calls: 1, complete: false });
    expect(
      h.root.session.snapshotEvents().filter((e) => e.type === 'llm/retry'),
    ).toHaveLength(0);
  },
);
it.each(['error', 'aborted', 'max-tokens'])(
  'retains actual usage on a native %s finish',
  async (kind) => {
    const receipts = [];
    const h = await host({
      accounting: true,
      runId: randomUUID(),
      bridge: recorder(receipts),
      stream: async function* () {
        yield { type: 'usage', usage };
        yield {
          type: 'finish',
          reason: {
            kind,
            ...(kind === 'error'
              ? { error: { message: 'provider failed' } }
              : {}),
          },
        };
      },
    });
    await consume(h.ctx.llm.stream(options(h)));
    await h.server.nativeAccounting.flush();
    const finish = receipts.find((p) => p.fact?.phase === 'finish').fact;
    expect(finish).toMatchObject({ usage, usageComplete: true });
    expect(finish.callId).toBe(receipts[0].fact.callId);
  },
);
it('flush waits for the active iterator finally and late receipt even with no pending start RPC', async () => {
  const entered = gate(),
    release = gate(),
    finishEntered = gate(),
    finishRelease = gate(),
    receipts = [];
  const h = await host({
    accounting: true,
    runId: randomUUID(),
    usage,
    model: async () => {
      entered.resolve();
      await release.promise;
      return text('已完成');
    },
    bridge: recorder(receipts, async (p) => {
      if (p.fact?.phase === 'finish') {
        finishEntered.resolve();
        await finishRelease.promise;
      }
    }),
  });
  const consuming = consume(h.ctx.llm.stream(options(h)));
  await entered.promise;
  let flushed = false;
  const flushing = h.server.nativeAccounting.flush().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  expect(flushed).toBe(false);
  release.resolve();
  await finishEntered.promise;
  expect(flushed).toBe(false);
  finishRelease.resolve();
  await Promise.all([consuming, flushing]);
  expect(receipts.at(-1).delivery).toEqual({ calls: 1, complete: true });
});
it.each([
  { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  { inputTokens: 20, outputTokens: 7 },
])('keeps synthetic zero or missing cache unknown: %j', async (raw) => {
  const receipts = [];
  const h = await host({
    accounting: true,
    runId: randomUUID(),
    usage: raw,
    bridge: recorder(receipts),
  });
  await h.prompt('保留已知用量，不补出缓存数字。');
  await h.wait();
  expect(
    receipts.find((p) => p.fact?.phase === 'finish').fact.usageComplete,
  ).toBe(false);
});

it.each(['allrice-restricted', 'allrice-technical'])(
  'enables accounting on the actual %s profile without extra capability plugins',
  async (productionProfile) => {
    const receipts = [];
    const h = await host({
      productionProfile,
      accounting: true,
      runId: randomUUID(),
      usage,
      bridge: recorder(receipts),
    });
    await h.prompt('核对本轮模型调用用量。');
    await h.wait();
    await h.server.nativeAccounting.flush();
    expect(h.calls).toHaveLength(1);
    expect(receipts.find((p) => p.fact?.phase === 'finish').fact).toMatchObject(
      { usage, usageComplete: true },
    );
  },
);

it.each([
  {
    raw: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    complete: true,
  },
  {
    raw: {
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 3,
      totalTokens: 28,
    },
    complete: true,
  },
  {
    raw: { inputTokens: 20, outputTokens: 5, totalTokens: 28 },
    complete: false,
  },
  ...[null, -1, NaN, '0'].map((cacheReadTokens) => ({
    raw: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens },
    complete: false,
  })),
  ...[null, -1, NaN, '3600', 3601].map((totalTokens) => ({
    raw: { ...usage, totalTokens },
    complete: false,
  })),
  { raw: { outputTokens: 5, totalTokens: 5 }, complete: false },
  { raw: { inputTokens: 20, totalTokens: 20 }, complete: false },
])(
  'uses original valid buckets and exact total to prove only omitted zero cache: %j',
  async ({ raw, complete }) => {
    const receipts = [];
    const h = await host({
      accounting: true,
      runId: randomUUID(),
      usage: raw,
      bridge: recorder(receipts),
    });
    await h.prompt('核对本次实际调用，不假定缺桶为零。');
    await h.wait();
    const finish = receipts.find((p) => p.fact?.phase === 'finish').fact;
    expect(finish.usageComplete).toBe(complete);
    if (complete)
      expect(finish.usage).toMatchObject({
        ...raw,
        cacheReadTokens: raw.cacheReadTokens ?? 0,
        cacheWriteTokens: 0,
      });
  },
);

it('an exact zero-cache total does not manufacture a missing native finish', async () => {
  const receipts = [];
  const h = await host({
    accounting: true,
    runId: randomUUID(),
    bridge: recorder(receipts),
    stream: async function* () {
      yield {
        type: 'usage',
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      };
    },
  });
  await consume(h.ctx.llm.stream(options(h)));
  expect(receipts.find((p) => p.fact?.phase === 'finish').fact).toMatchObject({
    outcome: 'incomplete',
    usageComplete: false,
    usage: {
      inputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      totalTokens: 25,
    },
  });
});

it.each([false, true])(
  'keeps message-only cache unknown while actual ledger requires finish=%s',
  async (terminal) => {
    const receipts = [],
      runId = randomUUID();
    const raw = { inputTokens: 20, outputTokens: 5, totalTokens: 25 };
    const h = await host({
      productionProfile: 'allrice-restricted',
      accounting: true,
      runId,
      bridge: recorder(receipts),
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '只记录实际调用。' };
        yield { type: 'usage', usage: raw };
        if (terminal) yield { type: 'finish', reason: { kind: 'stop' } };
      },
    });
    await h.prompt('只记录实际调用，不从消息假定模型已终止。');
    await h.wait();
    await h.server.handleRequest('run/end', { runId });
    expect(h.calls).toHaveLength(1);
    const message = h.notices.find(
      (p) =>
        p.method === 'session.event' &&
        p.params.event.type === 'assistant/message',
    )?.params.event.data;
    expect(message?.usage).toEqual(raw);
    expect(projectNativeUsage(message.usage, true, false)).toMatchObject({
      inputTokens: 20,
      outputTokens: 5,
      usageComplete: true,
      cacheUsageKnown: false,
    });
    expect(receipts.find((p) => p.fact?.phase === 'finish').fact).toMatchObject(
      {
        outcome: terminal ? 'succeeded' : 'incomplete',
        usageComplete: terminal,
        usage: { ...raw, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    );
    expect(receipts.at(-1).delivery).toEqual({ calls: 1, complete: true });
  },
);
