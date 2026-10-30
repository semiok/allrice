import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { gate, hold, host, text } from './fixture.mjs';
import { controlStdio } from './control-stdio.fixture.mjs';

const runId = randomUUID();
const scope = {
  rootRunId: runId,
  nativeRootId: 'pr0-root',
  generation: 1,
  jobId: randomUUID(),
  jobAttempt: 1,
  rootOriginDigest: `sha256:${'a'.repeat(64)}`,
  storageNamespace: '/fixture/server-frozen',
};
const bridge = async (method) =>
  method === 'allrice/run-authorize'
    ? { allowed: true }
    : { validUntil: Date.now() + 30_000 };
const command = (h, child, parent = h.root) => ({
  scope,
  input: {
    requestId: randomUUID(),
    kind: 'prompt',
    parentSessionId: parent.id,
    childSessionId: child.childId,
    mode: 'continuable',
    delivery: 'queue',
    content: text('给这个子任务补充材料。'),
  },
});
async function received(h, request) {
  const observed = await h.ctx.sessionQuery.observeSession(
    request.input.childSessionId,
  );
  try {
    return observed.events
      .slice(observed.inheritedEventCount)
      .filter(
        (event) =>
          event.type === 'user/message' &&
          event.data.source?.rpcId === request.input.requestId,
      );
  } finally {
    observed[Symbol.dispose]();
  }
}

it.each([
  ['capacity', 'subagent/delivery-unavailable'],
  ['parent', 'subagent/parent-unavailable'],
  ['timezone', 'subagent/invalid-time-zone'],
])(
  'stdio keeps the actual native %s refusal distinct from delivery uncertainty',
  async (reason, code) => {
    const release = gate(),
      rootRelease = gate();
    let holding = false;
    const h = await host({
      runId,
      bridge,
      depth: 2,
      model: async (request) => {
        if (request.sessionId === scope.nativeRootId)
          await hold(request.signal, rootRelease);
        else if (holding) await hold(request.signal, release);
        return text('完成');
      },
    });
    const client = await controlStdio(h, runId);
    await h.prompt('保留根运行，独立补充子任务。');
    let child,
      parent = h.root;
    if (reason === 'parent') {
      holding = true;
      const a = await h.spawn();
      await expect
        .poll(() => h.calls.some((request) => request.sessionId === a.childId))
        .toBe(true);
      parent = h.ctx.agents.get(a.childId);
      holding = false;
      child = await h.spawn(parent);
      await child.result;
      release.resolve();
      await a.result;
      expect(h.ctx.agents.get(parent.id)).toBeUndefined();
    } else {
      child = await h.spawn();
      await child.result;
      if (reason === 'capacity') {
        holding = true;
        for (let i = 0; i < 8; i++) await h.spawn();
      }
    }
    const request = command(h, child, parent);
    if (reason === 'timezone') request.input.clientTimeZone = 'not-a-zone';
    try {
      await expect(client.nativeSubagentControl(request)).rejects.toMatchObject(
        { code, retryable: false },
      );
      expect(await received(h, request)).toHaveLength(0);
    } finally {
      release.resolve();
      rootRelease.resolve();
      await h.wait();
    }
  },
);

it('actual SDK stdio loses an accepted ACK and times out without inventing a refusal', async () => {
  const rootRelease = gate();
  const h = await host({
    runId,
    bridge,
    model: async (request) => {
      if (request.sessionId === scope.nativeRootId)
        await hold(request.signal, rootRelease);
      return text('完成');
    },
  });
  let deliveries = 0;
  const client = await controlStdio(h, runId, {
    requestTimeoutMs: 1_000,
    handle: async (method, params) => {
      const result = await h.server.handleRequest(method, params);
      if (method !== 'subagents/control') return result;
      deliveries++;
      // DSH really accepted it. Suppress only the response after that fact;
      // the production client's own pending-request timer must fire.
      expect(result.messageId).toEqual(expect.any(String));
      return new Promise(() => {});
    },
  });
  await h.prompt('保留原 Run，等待补充。');
  const child = await h.spawn();
  await child.result;
  const request = command(h, child);
  await expect(client.nativeSubagentControl(request)).rejects.toMatchObject({
    code: 'DSH_REQUEST_TIMEOUT',
  });
  rootRelease.resolve();
  await h.wait();
  expect(await received(h, request)).toHaveLength(1);
  expect(deliveries).toBe(1);
});
