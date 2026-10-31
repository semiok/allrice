import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { gate, hold, host, text } from './fixture.mjs';

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
const bridge = async (method, params) => {
  if (method === 'allrice/run-authorize') return { allowed: true };
  expect(method).toBe('allrice/subagent-authorize');
  expect(params.scope).toEqual(scope);
  return { validUntil: Date.now() + 30_000 };
};
const input = (h, child, message, delivery = 'queue') => ({
  scope,
  input: {
    requestId: randomUUID(),
    parentSessionId: h.root.id,
    childSessionId: child.childId,
    mode: 'continuable',
    ...(message === undefined
      ? { kind: 'interrupt' }
      : { kind: 'prompt', content: text(message), delivery }),
  },
});
const control = (h, request) =>
  h.server.handleRequest('subagents/control', request);
const ownMessages = (agent) =>
  agent.session.snapshotEvents().filter((e) => e.type === 'user/message');

it('“给子任务补充图片”：native Queue/Steer admit image-only and mixed parts; reject an invalid whole batch', async () => {
  const release = gate();
  const h = await host({
    runId,
    bridge,
    model: async (r) => {
      await hold(r.signal, release);
      return text('完成');
    },
  });
  const child = await h.spawn();
  expect(h.root.status).toBe('idle');
  const idle = await h.server.handleRequest('session/subagent-summary', {
    sessionId: h.root.id,
  });
  expect(
    idle.descendants.find((row) => row.id === child.childId)?.parentAvailable,
  ).toBe(true);
  await h.prompt('保持活动');
  await expect.poll(() => h.calls.length).toBe(2);
  const agent = h.ctx.agents.get(child.childId);
  const picture = {
    type: 'image',
    mediaType: 'image/png',
    name: '补充.png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  };
  const mixed = input(h, child, '请看图');
  mixed.input.content.push(picture);
  const queued = await control(h, mixed);
  expect(agent.inbox.nextTurn).toContainEqual(
    expect.objectContaining({
      id: queued.messageId,
      content: [
        ...text('请看图'),
        {
          type: 'image',
          attachment: expect.objectContaining({
            mediaType: 'image/png',
            name: '补充.png',
            width: 1,
            height: 1,
          }),
        },
      ],
    }),
  );
  const bad = input(h, child, '整批拒绝');
  bad.input.content.push(picture, { ...picture, mediaType: 'image/jpeg' });
  await expect(control(h, bad)).resolves.toEqual({
    status: 'rejected',
    code: 'subagent/attachment-invalid',
  });
  expect(agent.inbox.nextTurn).toHaveLength(1);
  const only = input(h, child, '', 'steer');
  only.input.content = [picture];
  const steered = await control(h, only);
  await expect
    .poll(
      () =>
        ownMessages(agent).filter((event) =>
          [queued.messageId, steered.messageId].includes(event.data.id),
        ).length,
    )
    .toBe(2);
  expect(
    ownMessages(h.root).some((event) =>
      [queued.messageId, steered.messageId].includes(event.data.id),
    ),
  ).toBe(false);
  const directory = await h.server.handleRequest('session/subagent-summary', {
    sessionId: h.root.id,
  });
  expect(
    directory.descendants.find((row) => row.id === child.childId)
      ?.parentAvailable,
  ).toBe(true);
  expect(
    h.notices.some(
      (notice) =>
        notice.method === 'session.agent-availability' &&
        notice.params.sessionId === child.childId,
    ),
  ).toBe(true);
  release.resolve();
  await h.wait();
});

it('“只停这个子任务，再给另一个补充材料” preserves the parent question and sibling', async () => {
  const children = gate();
  let roots = 0;
  const h = await host({
    runId,
    bridge,
    model: async (r) => {
      if (r.sessionId !== 'pr0-root') await hold(r.signal, children);
      else if (++roots === 1)
        return [
          {
            type: 'tool-call',
            id: 'ask',
            name: 'ask_user_question',
            arguments: JSON.stringify({
              timeout: -1,
              questions: [
                {
                  id: 'go',
                  question: '要继续吗？',
                  options: [{ label: '继续' }],
                },
              ],
            }),
          },
        ];
      return text('完成');
    },
  });
  await h.prompt('先问我，再等待两个子任务。');
  await expect
    .poll(() => h.server.pendingUserQuestions.has(h.root.id))
    .toBe(true);
  const question = h.server.pendingUserQuestions.get(h.root.id);
  const a = await h.spawn(),
    b = await h.spawn();
  await expect.poll(() => h.calls.length).toBe(3);
  const sibling = h.ctx.agents.get(b.childId);
  expect(await control(h, input(h, a))).toEqual({
    kind: 'interrupt',
    accepted: true,
  });
  await a.result;
  expect(sibling.status).toBe('running');
  expect(h.server.pendingUserQuestions.get(h.root.id)).toBe(question);
  expect(roots).toBe(1);
  const message = input(h, b, '继续');
  const receipt = await control(h, message);
  expect(receipt).toMatchObject({
    kind: 'prompt',
    messageId: expect.any(String),
  });
  expect(sibling.inbox.nextTurn).toContainEqual(
    expect.objectContaining({
      id: receipt.messageId,
      source: expect.objectContaining({
        kind: 'user',
        rpcId: message.input.requestId,
      }),
    }),
  );
  expect(h.server.pendingUserQuestions.get(h.root.id)).toBe(question);
  await h.server.handleRequest('session/steer', {
    sessionId: h.root.id,
    runId,
    inputId: randomUUID(),
    turnId: `${h.root.id}:turn:1`,
    kind: 'ask_user',
    text: `allrice:user-question:v1:${JSON.stringify({ questionId: question.questionId, answers: [{ id: 'go', selected: ['继续'] }] })}`,
  });
  children.resolve();
  await h.wait();
  expect(
    ownMessages(sibling).filter(
      (e) => e.data.source.rpcId === message.input.requestId,
    ),
  ).toMatchObject([{ data: { id: receipt.messageId, content: text('继续') } }]);
  expect(
    ownMessages(h.root).some(
      (e) => e.data.source.rpcId === message.input.requestId,
    ),
  ).toBe(false);
});

it.each(['completed-before-grant', 'completed-during-grant', 'parked-idle'])(
  '“停止这个子任务” preserves native accepted no-op: %s',
  async (state) => {
    const aEntered = gate(),
      aRelease = gate(),
      bRelease = gate();
    const granting = gate(),
      grantRelease = gate();
    let childCalls = 0,
      rootCalls = 0;
    const h = await host({
      runId,
      bridge: async (method, params) => {
        if (method === 'allrice/subagent-authorize') {
          granting.resolve();
          await grantRelease.promise;
        }
        return bridge(method, params);
      },
      model: async (r) => {
        if (r.sessionId === 'pr0-root') {
          if (++rootCalls === 1)
            return [
              {
                type: 'tool-call',
                id: 'ask',
                name: 'ask_user_question',
                arguments: JSON.stringify({
                  timeout: -1,
                  questions: [
                    {
                      id: 'go',
                      question: '继续吗？',
                      options: [{ label: '继续' }],
                    },
                  ],
                }),
              },
            ];
        } else if (++childCalls === 1) {
          aEntered.resolve();
          await hold(r.signal, aRelease);
        } else await hold(r.signal, bRelease);
        return text('完成');
      },
    });
    await h.prompt('等我答题，先停选中的子任务。');
    await expect
      .poll(() => h.server.pendingUserQuestions.has(h.root.id))
      .toBe(true);
    const question = h.server.pendingUserQuestions.get(h.root.id);
    const a = await h.spawn();
    await aEntered.promise;
    const aAgent = h.ctx.agents.get(a.childId);
    const b = await h.spawn();
    await expect.poll(() => childCalls).toBe(2);
    if (state === 'parked-idle') {
      h.inject(aAgent, '保留的材料');
      h.ctx.subagents.interruptByParent(a.childId, h.root.id, 'continuable');
      await aAgent.whenIdle();
    } else if (state === 'completed-before-grant') {
      aRelease.resolve();
      await a.result;
    }
    const stopped = control(h, input(h, a));
    await granting.promise;
    if (state === 'completed-during-grant') {
      aRelease.resolve();
      await a.result;
    }
    grantRelease.resolve();
    expect(await stopped).toEqual({ kind: 'interrupt', accepted: true });
    expect(h.server.pendingUserQuestions.get(h.root.id)).toBe(question);
    expect(rootCalls).toBe(1);
    expect(h.ctx.agents.get(b.childId).status).toBe('running');
    if (state === 'parked-idle') expect(aAgent.inbox.nextStep).toHaveLength(1);
    else expect(h.ctx.agents.get(a.childId)).toBeUndefined();
    await h.server.handleRequest('session/steer', {
      sessionId: h.root.id,
      runId,
      inputId: randomUUID(),
      turnId: `${h.root.id}:turn:1`,
      kind: 'ask_user',
      text: `allrice:user-question:v1:${JSON.stringify({ questionId: question.questionId, answers: [{ id: 'go', selected: ['继续'] }] })}`,
    });
    bRelease.resolve();
    await h.wait();
  },
);

it.each(['queue', 'steer'])(
  '“给完成的子任务补一句” resumes its same ID with native %s',
  async (delivery) => {
    const rootRelease = gate();
    const h = await host({
      runId,
      bridge,
      model: async (r) => {
        if (r.sessionId === 'pr0-root') await hold(r.signal, rootRelease);
        return text('完成');
      },
    });
    await h.prompt('等我补材料后再总结。');
    const child = await h.spawn();
    await child.result;
    expect(h.ctx.agents.get(child.childId)).toBeUndefined();
    const request = input(h, child, '请加上上海。', delivery);
    const resumed = gate();
    const dispose = h.ctx.on('agent/created', ({ agent }) => {
      if (agent.id === child.childId) resumed.resolve(agent);
    });
    const receipt = await control(h, request);
    const agent = await resumed.promise;
    rootRelease.resolve();
    await h.wait();
    expect(agent.id).toBe(child.childId);
    expect(ownMessages(agent)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          id: receipt.messageId,
          source: expect.objectContaining({
            kind: 'user',
            rpcId: request.input.requestId,
          }),
        }),
      }),
    );
    dispose();
    await expect(control(h, input(h, child, '根结束后不续跑'))).rejects.toThrow(
      'RUN_COMPLETING',
    );
  },
);

it.each(['window', 'end', 'lease', 'epoch'])(
  'revokes a real cold-child admission while awaiting creation: %s',
  async (boundary) => {
    const rootRelease = gate(),
      creating = gate(),
      release = gate();
    let expires;
    const h = await host({
      runId,
      bridge: async (method, params) => {
        const grant = await bridge(method, params);
        return method === 'allrice/subagent-authorize'
          ? { validUntil: expires ?? Date.now() + 30_000 }
          : grant;
      },
      model: async (r) => {
        if (r.sessionId === 'pr0-root') await hold(r.signal, rootRelease);
        return text('完成');
      },
    });
    await h.prompt('等我补材料。');
    const child = await h.spawn();
    await child.result;
    const callsBefore = h.calls.length;
    const dispose = h.ctx.on('agent/created', async ({ agent, signal }) => {
      if (agent.id !== child.childId) return;
      creating.resolve();
      await hold(signal, release);
    });
    if (boundary === 'lease') expires = Date.now() + 100;
    const request = input(h, child, '这条未获接收时就撤销。');
    const result = control(h, request).then(
      () => 'accepted',
      (error) => error.message,
    );
    await creating.promise;
    if (boundary === 'window')
      await h.server.handleRequest('run/close-input', { runId });
    if (boundary === 'end') await h.server.handleRequest('run/end', { runId });
    const closing =
      boundary === 'epoch' ? h.server.closeRoot(h.root.id) : undefined;
    // Let the native signal cancel creation; no private wake or replay is used.
    expect(await result).not.toBe('accepted');
    release.resolve();
    rootRelease.resolve();
    await closing;
    if (boundary !== 'end' && boundary !== 'epoch') await h.wait();
    expect(h.calls.filter((r) => r.sessionId === child.childId)).toHaveLength(
      1,
    );
    expect(h.calls.length).toBeGreaterThanOrEqual(callsBefore);
    dispose();
  },
);

it('rejects stale/foreign addresses before authorization and never creates a cold Host/root', async () => {
  const rootRelease = gate();
  const authorize = vi.fn(bridge);
  const h = await host({
    runId,
    bridge: authorize,
    model: async (r) => {
      if (r.sessionId === 'pr0-root') await hold(r.signal, rootRelease);
      return text('完成');
    },
  });
  const fake = { childId: 'missing-child' };
  await expect(control(h, input(h, fake))).rejects.toThrow('RUN_COMPLETING');
  await h.prompt('保持本轮活动。');
  const child = await h.spawn();
  await child.result;
  const request = input(h, child, '补充');
  for (const invalid of [
    { ...request, scope: { ...scope, rootRunId: randomUUID() } },
    { ...request, scope: { ...scope, nativeRootId: 'other-root' } },
    {
      ...request,
      input: { ...request.input, parentSessionId: 'other-parent' },
    },
    {
      ...request,
      input: { ...request.input, childSessionId: 'missing-child' },
    },
    { ...request, input: { ...request.input, mode: 'one-shot' } },
  ])
    await expect(control(h, invalid)).rejects.toThrow();
  expect(
    authorize.mock.calls.filter(
      ([method]) => method === 'allrice/subagent-authorize',
    ),
  ).toEqual([]);
  expect(h.ctx.agents.get('other-root')).toBeUndefined();
  expect(h.root.status).toBe('running');
  rootRelease.resolve();
  await h.wait();
});

it('new human input during an aborted child turn follows native wake convergence', async () => {
  const rootRelease = gate(),
    childRelease = gate(),
    aborted = gate(),
    unwind = gate();
  let childCalls = 0;
  const h = await host({
    runId,
    bridge,
    model: async (r) => {
      if (r.sessionId === 'pr0-root') await hold(r.signal, rootRelease);
      else if (++childCalls === 1) {
        try {
          await hold(r.signal, childRelease);
        } finally {
          aborted.resolve();
          await unwind.promise;
        }
      }
      return text('完成');
    },
  });
  await h.prompt('先等子任务。');
  const child = await h.spawn();
  await expect.poll(() => childCalls).toBe(1);
  const childAgent = h.ctx.agents.get(child.childId);
  h.inject(childAgent, '停止也要保留的已有材料');
  await control(h, input(h, child));
  await aborted.promise;
  expect(childAgent.inbox.nextStep).toContainEqual(
    expect.objectContaining({ content: text('停止也要保留的已有材料') }),
  );
  const receipt = await control(
    h,
    input(h, child, '停止后按新材料继续。', 'steer'),
  );
  expect(receipt.kind).toBe('prompt');
  unwind.resolve();
  await child.result;
  expect(childCalls).toBe(2);
  rootRelease.resolve();
  await h.wait();
});

it('a pending child authorization does not serialize the root input handler', async () => {
  const rootRelease = gate(),
    authorizing = gate(),
    grantRelease = gate();
  const h = await host({
    runId,
    bridge: async (method, params) => {
      if (method === 'allrice/subagent-authorize') {
        authorizing.resolve();
        await grantRelease.promise;
      }
      return bridge(method, params);
    },
    model: async (r) => {
      if (r.sessionId === 'pr0-root') await hold(r.signal, rootRelease);
      return text('完成');
    },
  });
  await h.prompt('当前根继续接收输入。');
  const child = await h.spawn();
  await child.result;
  const pending = control(h, input(h, child, '稍后接收'));
  await authorizing.promise;
  const result = await h.server.handleRequest('session/steer', {
    sessionId: h.root.id,
    runId,
    text: '父任务仍可以收到这句。',
  });
  expect(result).toMatchObject({ messageId: expect.any(String) });
  await setImmediate();
  grantRelease.resolve();
  await pending;
  rootRelease.resolve();
  await h.wait();
});

it('stop uses the exact durable child address without demanding a live direct parent', async () => {
  const release = gate();
  const h = await host({
    runId,
    bridge,
    depth: 2,
    model: async (r) => {
      await hold(r.signal, release);
      return text('完成');
    },
  });
  await h.prompt('等待子任务。');
  const parent = await h.spawn();
  const child = await h.spawn(h.ctx.agents.get(parent.childId));
  await expect.poll(() => h.calls.length).toBe(3);
  const get = h.ctx.agents.get.bind(h.ctx.agents);
  // Fault injection at the public registry read, without taking DSH-owned handles.
  const absentParent = vi
    .spyOn(h.ctx.agents, 'get')
    .mockImplementation((id) => (id === parent.childId ? undefined : get(id)));
  try {
    const request = input(h, child);
    request.input.parentSessionId = parent.childId;
    expect(await control(h, request)).toEqual({
      kind: 'interrupt',
      accepted: true,
    });
  } finally {
    absentParent.mockRestore();
  }
  await child.result;
  expect(get(parent.childId).status).toBe('running');
  expect(h.root.status).toBe('running');
  release.resolve();
  await h.wait();
});
