/* global AbortController */
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { HandlerError } from '../../src/errors.ts';
import { gate, host, text } from './fixture.mjs';
import { controlStdio } from './control-stdio.fixture.mjs';

const python = {
  type: 'tool-call',
  id: 'calculate',
  name: 'python_execute',
  arguments: JSON.stringify({ script: 'print(21)', location: 'cloud' }),
};
const search = {
  type: 'tool-call',
  id: 'search',
  name: 'web_search',
  arguments: JSON.stringify({ queries: ['甲', '乙'] }),
};
const question = {
  type: 'tool-call',
  id: 'ask',
  name: 'ask_user_question',
  arguments: JSON.stringify({
    timeout: -1,
    questions: [
      { id: 'go', question: '继续吗？', options: [{ label: '继续' }] },
    ],
  }),
};

async function fixture(tool = python) {
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
  let peer, target;
  const invocations = new Map(),
    dispatched = [],
    outcomes = [],
    results = [];
  const h = await host({
    runId,
    nativeTools: ['python.execute', 'web.search'],
    bridge: (method, params, signal) => peer.request(method, params, signal),
    model: async (request) => {
      const count = (invocations.get(request.sessionId) ?? 0) + 1;
      invocations.set(request.sessionId, count);
      if (request.sessionId === scope.nativeRootId)
        return count === 1 ? [question] : text('父任务继续');
      target ??= request.sessionId;
      if (count === 1) return [request.sessionId === target ? tool : python];
      return text('兄弟任务完成');
    },
  });
  // Real production client and SDK transport, separated by the byte-only OS
  // stdio relay. Only the Worker resource body is a controlled remote reply.
  const client = await controlStdio(h, runId, {
    onPeer: (value) => (peer = value),
  });
  client.setRequestHandler(async (method, params) => {
    if (method === 'allrice/run-authorize') return { allowed: true };
    if (method === 'allrice/subagent-authorize')
      return { validUntil: Date.now() + 30_000 };
    if (method === 'test/barrier') return {};
    expect(method).toBe('allrice/tool-call');
    const reply = gate();
    dispatched.push({ params, reply });
    const outcome = await reply.promise;
    outcomes.push({ params, outcome });
    if (outcome.error)
      throw new HandlerError('CLOUD_RESULT_UNKNOWN', outcome.error, false);
    return {
      modelContent: outcome.content ?? '远端自然完成，已产生输出及用量',
    };
  });
  h.ctx.on('tools/result', (exec, result) => {
    results.push({ agentId: exec.agent.id, callId: exec.callId, result });
  });
  await h.prompt('父任务先等我回答，让甲乙并行；只停止甲，乙继续。');
  await expect
    .poll(() => h.server.pendingUserQuestions.has(h.root.id))
    .toBe(true);
  const pendingQuestion = h.server.pendingUserQuestions.get(h.root.id);
  return {
    ...h,
    client,
    dispatched,
    outcomes,
    results,
    invocations,
    pendingQuestion,
    stop: (child) =>
      client.nativeSubagentControl({
        scope,
        input: {
          requestId: randomUUID(),
          kind: 'interrupt',
          parentSessionId: h.root.id,
          childSessionId: child.childId,
          mode: 'continuable',
        },
      }),
    barrier: async () => {
      await peer.request('test/barrier', {});
      await setImmediate();
    },
    answer: () =>
      h.server.handleRequest('session/steer', {
        sessionId: h.root.id,
        runId,
        inputId: randomUUID(),
        turnId: `${h.root.id}:turn:1`,
        kind: 'ask_user',
        text: `allrice:user-question:v1:${JSON.stringify({ questionId: pendingQuestion.questionId, answers: [{ id: 'go', selected: ['继续'] }] })}`,
      }),
    release: () => {
      for (const request of dispatched) request.reply.resolve({});
    },
  };
}

it.each([
  ['python success', python, -1],
  ['python failure', python, 0],
  ['search success', search, -1],
  ['search first failure', search, 0],
  ['search second failure', search, 1],
])(
  '“只停甲，乙继续”：%s waits for every dispatched body after its positive ACK',
  async (_name, tool, failure) => {
    const f = await fixture(tool);
    const count = tool === search ? 2 : 1;
    let answered = false;
    try {
      const a = await f.spawn();
      await expect.poll(() => f.dispatched.length).toBe(count);
      const agent = f.ctx.agents.get(a.childId);
      let ended = false;
      void a.result.then(() => (ended = true));
      const b = await f.spawn();
      await expect.poll(() => f.dispatched.length).toBe(count + 1);
      const requests = f.dispatched.filter(
        (call) => call.params.nativeSessionId === a.childId,
      );
      expect(requests).toHaveLength(count);
      expect(new Set(requests.map((call) => call.params.toolCallId)).size).toBe(
        count,
      );
      expect(await f.stop(a)).toEqual({ kind: 'interrupt', accepted: true });
      await f.barrier();
      expect(ended).toBe(false);
      expect(agent.status).toBe('running');
      expect(
        agent.session.snapshotEvents().some((e) => e.type === 'turn/end'),
      ).toBe(false);
      expect(f.server.pendingUserQuestions.get(f.root.id)).toBe(
        f.pendingQuestion,
      );

      // The sibling and parent both make real progress while A still waits.
      f.dispatched
        .find((call) => call.params.nativeSessionId === b.childId)
        .reply.resolve({ content: '乙完成55' });
      await b.result;
      expect(f.invocations.get(b.childId)).toBe(2);
      await f.answer();
      answered = true;
      await expect.poll(() => f.invocations.get(f.root.id)).toBeGreaterThan(1);
      expect(ended).toBe(false);
      expect(f.invocations.get(a.childId)).toBe(1);

      if (count === 2) {
        const first = failure < 0 ? 0 : failure;
        requests[first].reply.resolve(
          failure < 0 ? {} : { error: '远端明确失败' },
        );
        await expect
          .poll(
            () =>
              f.outcomes.filter((o) => o.params.nativeSessionId === a.childId)
                .length,
          )
          .toBe(1);
        await f.barrier();
        expect(ended).toBe(false);
        expect(agent.status).toBe('running');
        requests[1 - first].reply.resolve({});
      } else
        requests[0].reply.resolve(failure < 0 ? {} : { error: '远端明确失败' });
      await a.result;
      await f.wait();
      expect(f.dispatched).toHaveLength(count + 1);
      expect(
        f.outcomes.filter((o) => o.params.nativeSessionId === a.childId),
      ).toHaveLength(count);
      expect(f.invocations.get(a.childId)).toBe(1);
      const result = f.results.find((r) => r.agentId === a.childId).result;
      expect(result.isError).toBe(true);
      if (failure < 0) expect(result.error.info.code).toBe('ABORTED');
      else {
        expect(JSON.stringify(result)).toContain('远端明确失败');
        expect(result.error.info?.code).not.toBe('ABORTED');
      }
      expect(
        agent.session.snapshotEvents().findLast((e) => e.type === 'turn/end'),
      ).toMatchObject({
        data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
      });
    } finally {
      f.release();
      if (!answered) await f.answer();
      await f.wait();
    }
  },
  15_000,
);

it('cancellation before native body and at actual broker dispatch sends no Worker call', async () => {
  const f = await fixture();
  const entered = gate(),
    release = gate();
  f.ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'python_execute') {
      entered.resolve();
      await release.promise;
    }
    return next();
  });
  try {
    const child = await f.spawn();
    await entered.promise;
    expect(await f.stop(child)).toEqual({ kind: 'interrupt', accepted: true });
    release.resolve();
    await child.result;
    const caller = new AbortController();
    caller.abort(Error('pre-dispatch cancellation'));
    expect(() =>
      f.server.toolBrokerRequest(
        { nativeSessionId: child.childId },
        caller.signal,
      ),
    ).toThrow('pre-dispatch cancellation');
    await f.barrier();
    expect(f.dispatched).toHaveLength(0);
    expect(
      f.results.find((r) => r.agentId === child.childId).result,
    ).toMatchObject({
      isError: true,
      error: { info: { code: 'ABORTED_BEFORE_DISPATCH' } },
    });
  } finally {
    release.resolve();
    f.release();
    await f.answer();
    await f.wait();
  }
});
