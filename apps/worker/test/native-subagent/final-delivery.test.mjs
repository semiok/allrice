/* global AbortController, structuredClone */
import { setImmediate } from 'node:timers';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createAssistantMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { host, text, gate, hold } from './fixture.mjs';
import { digestText } from '../../dsh/allrice-final-delivery-repair.mjs';
import { verifyRestoredFinalReplyOrigin } from '../../dsh/allrice-final-reply-origin.mjs';

async function subject(
  model,
  transform = (origin) => origin,
  authorize = async () => {},
) {
  const runId = randomUUID();
  let f;
  f = await host({
    model,
    bridge: async (method, params) => {
      expect([
        'allrice/final-delivery-origin',
        'allrice/final-delivery-authorize',
      ]).toContain(method);
      expect(params).toEqual({ nativeSessionId: f.root.id, rootRunId: runId });
      if (method === 'allrice/final-delivery-authorize') await authorize();
      return {
        origin: transform({
          schemaVersion: 1,
          rootRunId: runId,
          nativeSessionId: f.root.id,
          starts: f.root.session
            .snapshotEvents()
            .filter((e) => e.type === 'turn/start')
            .map((e) => ({
              runEventId: `control-${e.seq}`,
              runEventSequence: e.seq,
              turnId: `${f.root.id}:turn:${e.data.turn}`,
            })),
        }),
      };
    },
  });
  const call = (action, params = {}) =>
    f.server.handleRequest(`allrice/final-delivery/${action}`, {
      sessionId: f.root.id,
      ...params,
    });
  await call('bind', { rootRunId: runId });
  const finish = (candidate, overrides = {}) =>
    call('finish', {
      completionToken: candidate.completionToken,
      candidateDigest: candidate.textDigest,
      factSetDigest: digestText('facts'),
      ...overrides,
    });
  const repair = (candidate) =>
    call('repair', {
      completionToken: candidate.completionToken,
      inspection: {
        decision: 'repair',
        candidateDigest: candidate.textDigest,
        factSetDigest: digestText('facts'),
        issues: ['missing_delivery_link'],
        references: [],
      },
    });
  return { ...f, call, finish, repair, runId };
}

it.each([
  ['', false],
  [' \n ', false],
  ['更新后的汇总', false],
  ['', true],
])(
  '双 child 结算尾步 %j、relay=%s：保留同一公开正文身份，不增加模型调用',
  async (tail, relay) => {
    const childrenRelease = gate(),
      rootEntered = gate(),
      answerRelease = gate();
    const answer = '甲：21  \n乙：55';
    let rootCalls = 0,
      childCalls = 0;
    const f = await subject(async (request) => {
      if (request.sessionId !== 'pr0-root') {
        const value = ++childCalls === 1 ? '21' : '55';
        await hold(request.signal, childrenRelease);
        return text(value);
      }
      if (++rootCalls === 1) {
        rootEntered.resolve();
        await hold(request.signal, answerRelease);
        return text(answer);
      }
      return [{ type: 'reasoning', text: 'private closure' }, ...text(tail)];
    });
    try {
      const first = await f.spawn(f.root, 'child 21');
      const second = await f.spawn(f.root, 'child 55');
      await f.prompt('汇总两个子任务。');
      await rootEntered.promise;
      let returned = false;
      const pending = f.call('candidate').then((value) => {
        returned = true;
        return value;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(returned).toBe(false);
      if (relay) {
        const child = f.ctx.agents
          .list()
          .find((agent) => agent.id !== f.root.id);
        await f.ctx.subagents.sendMessage(child, f.root.id, text('21'), {
          signal: new AbortController().signal,
        });
      }
      childrenRelease.resolve();
      await Promise.all([first.result, second.result]);
      answerRelease.resolve();
      const candidate = await pending;
      const events = f.root.session.snapshotEvents();
      const messages = events.filter((e) => e.type === 'assistant/message');
      expect(rootCalls).toBe(2);
      expect(childCalls).toBe(2);
      expect(events.filter((e) => e.type === 'turn/start')).toHaveLength(1);
      expect(messages).toHaveLength(2);
      const chosen = messages[tail.trim() ? 1 : 0];
      const body = tail.trim() ? tail : answer;
      expect(candidate).toMatchObject({
        answer: body,
        publicMessageId: chosen.data.message.id,
        durableSeq: chosen.seq,
        textDigest: digestText(body),
        sourceEvent: {
          type: chosen.type,
          seq: chosen.seq,
          time: chosen.time,
          data: { turn: chosen.data.turn, step: chosen.data.step },
        },
      });
      expect(JSON.stringify(candidate.sourceEvent)).not.toContain(
        'private closure',
      );
      expect(
        events.filter(
          (e) =>
            e.type === 'user/message' &&
            e.data.source.kind === 'subagent-settled',
        ),
      ).toHaveLength(2);
      expect(
        events.filter(
          (e) =>
            e.type === 'user/message' && e.data.source.kind === 'agent-message',
        ),
      ).toHaveLength(relay ? 1 : 0);

      if (tail === '' && !relay) {
        const ownedState = structuredClone(
          f.ctx.sessionProjections.checkpoint(f.root.session),
        );
        const nativeNotices = f.notices.length;
        // Mutate only a detached read cut; the production Host/journal remains intact.
        const verify = (copy) => {
          copy.forEach((e, seq) => {
            e.seq = seq;
          });
          const session = {
            id: f.root.id,
            header: f.root.session.header,
            snapshotEvents: () => copy,
          };
          const origin = {
            schemaVersion: 1,
            rootRunId: f.runId,
            nativeSessionId: f.root.id,
            starts: copy
              .filter((e) => e.type === 'turn/start')
              .map((e) => ({
                runEventId: `control-${e.seq}`,
                runEventSequence: e.seq,
                turnId: `${f.root.id}:turn:${e.data.turn}`,
              })),
          };
          return verifyRestoredFinalReplyOrigin(
            session,
            { runId: f.runId },
            origin,
          ).event;
        };
        const initial = (copy) =>
          copy.find((e) => e.type === 'assistant/message');
        const last = (copy) =>
          copy.findLast((e) => e.type === 'assistant/message');
        const insert = (copy, event) =>
          copy.splice(copy.indexOf(initial(copy)) + 1, 0, event);
        const cases = [
          [
            'interrupted',
            (copy) => {
              last(copy).data.interrupted = true;
            },
          ],
          [
            'tool draft',
            (copy) => {
              initial(copy).data.message.content.push({
                type: 'tool-call',
                name: 'bash',
              });
            },
          ],
          [
            'tail tool',
            (copy) => {
              last(copy).data.message.content.push({
                type: 'tool-call',
                name: 'bash',
              });
            },
          ],
          [
            'envelope',
            (copy) => {
              initial(copy).data.message.content = text(
                '<allrice_tool_call>{}</allrice_tool_call>',
              );
            },
          ],
          [
            'partial think',
            (copy) => {
              initial(copy).data.message.content = text('<think>hidden');
            },
          ],
          [
            'replacement',
            (copy) => {
              initial(copy).surfaceOp = { op: 'replace', start: 0, end: 0 };
            },
          ],
          [
            'new human',
            (copy) =>
              insert(copy, {
                type: 'user/message',
                surfaceOp: 'append',
                data: { source: { kind: 'user' } },
              }),
          ],
          [
            'new relay',
            (copy) =>
              insert(copy, {
                type: 'user/message',
                surfaceOp: 'append',
                data: { source: { kind: 'agent-message' } },
              }),
          ],
          [
            'new tool work',
            (copy) => insert(copy, { type: 'tool/call', data: {} }),
          ],
          [
            'unknown projection',
            (copy) => insert(copy, { type: 'unknown/replacement', data: {} }),
          ],
          [
            'canceled input',
            (copy) =>
              insert(copy, {
                type: 'agent/inbox/spliced',
                data: {
                  target: 'next-step',
                  outcome: 'canceled',
                  inserted: [],
                },
              }),
          ],
          [
            'removed human',
            (copy) => {
              const queued = copy.findLast(
                (e) =>
                  e.type === 'agent/inbox/spliced' && e.data.inserted.length,
              );
              queued.data.inserted[0].source = { kind: 'user' };
            },
          ],
          [
            'unknown child',
            (copy) => {
              copy.findLast(
                (e) => e.type === 'user/message',
              ).data.source.senderSessionId = 'unknown';
            },
          ],
          [
            'missing end',
            (copy) => {
              copy.pop();
            },
          ],
          ...['aborted', 'error', 'interrupted'].map((kind) => [
            kind,
            (copy) => {
              copy.at(-1).data.reason = { kind };
            },
          ]),
        ];
        for (const [name, mutate] of cases) {
          const copy = structuredClone(events);
          mutate(copy);
          if (
            [
              'interrupted',
              'tail tool',
              'missing end',
              'aborted',
              'error',
            ].includes(name)
          ) {
            expect(() => verify(copy), name).toThrow();
          } else {
            // A finalized body is not invalidated by the semantics of later
            // native input/work. Authority comes from the anchored turn and
            // completion gate, not a tail-event allowlist.
            const inputOrWork = [
              'new human',
              'new relay',
              'new tool work',
              'unknown projection',
              'canceled input',
              'removed human',
              'unknown child',
            ].includes(name);
            expect(verify(copy), name).toBe(
              inputOrWork ? initial(copy) : last(copy),
            );
          }
        }
        const noBody = structuredClone(events);
        initial(noBody).data.message.content = [
          { type: 'tool-call', name: 'bash' },
        ];
        expect(verify(noBody)).toBe(last(noBody));
        const newer = structuredClone(events),
          empty = structuredClone(messages[1]);
        empty.data.turn = 2;
        empty.data.message.id = randomUUID();
        newer.push({ type: 'turn/start', data: { turn: 2 } }, empty, {
          type: 'turn/end',
          data: { turn: 2, reason: { kind: 'completed' } },
        });
        expect(verify(newer)).toBe(empty);
        expect(
          empty.data.message.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join(''),
        ).toBe('');
        expect(f.ctx.sessionProjections.checkpoint(f.root.session)).toEqual(
          ownedState,
        );
        expect(f.root.session.snapshotEvents()).toEqual(events);
        expect(f.notices).toHaveLength(nativeNotices);
      }
      expect(await f.finish(candidate)).toMatchObject({
        released: true,
        publicMessageId: chosen.data.message.id,
        durableSeq: chosen.seq,
        textDigest: digestText(body),
      });
      expect(f.calls).toHaveLength(4);
    } finally {
      childrenRelease.resolve();
      answerRelease.resolve();
      await f.server.interrupt({ sessionId: f.root.id });
    }
  },
  20000,
);

it('中间文字之后真实工具再空答复：不给旧正文 proof，保留原有空候选修正路径', async () => {
  let toolCalls = 0;
  const f = await subject(async (_request, count) =>
    count === 1
      ? [
          ...text('正在处理文件。'),
          {
            type: 'tool-call',
            id: 'probe',
            name: 'final_probe',
            arguments: '{}',
          },
        ]
      : text(count === 2 ? '' : '修正后的文件链接。'),
  );
  f.ctx.tools.register(
    defineTool({
      name: 'final_probe',
      description: 'Offline delivery probe',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async () => {
        toolCalls++;
        return 'done';
      },
    }),
  );
  await f.prompt('处理文件。');
  const original = await f.call('candidate');
  expect(toolCalls).toBe(1);
  expect(original.answer).toBe('');
  expect(original.publicMessageId).toBe(
    f.root.session
      .snapshotEvents()
      .findLast((e) => e.type === 'assistant/message').data.message.id,
  );
  await f.repair(original);
  const repaired = await f.call('candidate');
  expect(repaired.answer).toBe('修正后的文件链接。');
  expect(f.calls).toHaveLength(3);
  expect(toolCalls).toBe(1);
  await f.finish(repaired);
  const handle = await f.ctx.sessionPersistence.open(f.root.id, 'read');
  try {
    await expect(handle.read()).resolves.toBeDefined();
  } finally {
    await handle.close();
  }
});

it('用户要月报下载链接：绑定实际原生回复，关住迟到输入，完成凭据只消费一次', async () => {
  const answer =
    '[月报](/api/v1/files/00000000-0000-4000-8000-000000000001/download)';
  const f = await subject(async () => text(answer));
  await f.prompt('请把月报整理成文件，把下载链接给我。');
  const candidate = await f.call('candidate');
  const native = f.root.session
    .snapshotEvents()
    .findLast((e) => e.type === 'assistant/message');
  expect(candidate).toMatchObject({
    answer,
    publicMessageId: native.data.message.id,
    durableSeq: native.seq,
    textDigest: digestText(answer),
    rootBinding: { runId: f.runId, nativeSessionId: f.root.id },
  });
  await expect(f.prompt('迟到的新问题')).rejects.toThrow('RUN_COMPLETING');
  await expect(
    f.server.steer({ sessionId: f.root.id, text: '迟到补充' }),
  ).rejects.toThrow('RUN_COMPLETING');
  await expect(
    f.finish(candidate, { candidateDigest: digestText('tampered') }),
  ).rejects.toThrow();
  expect(await f.finish(candidate)).toMatchObject({
    released: true,
    publicMessageId: native.data.message.id,
  });
  await expect(f.finish(candidate)).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
  await f.call('bind', { rootRunId: randomUUID() });
  await f.prompt('下一轮正常问题');
  await f.wait();
  expect(f.calls).toHaveLength(2);
});

it('Worker wait 后只做同 Agent/Run/模型的一次平台文字修正，原生新 turn 与原文都保留', async () => {
  const f = await subject(async (_request, count) =>
    text(count === 1 ? '月报已经完成。' : '这是已生成的月报下载链接。'),
  );
  await f.prompt('请给我月报下载链接。');
  const original = await f.call('candidate');
  const agent = f.root;
  await f.repair(original);
  const corrected = await f.call('candidate');
  expect(f.root).toBe(agent);
  expect(corrected.turn).toBe(original.turn + 1);
  expect(corrected.rootBinding).toEqual(original.rootBinding);
  expect(f.calls).toHaveLength(2);
  expect(f.calls.map((c) => [c.provider, c.model])).toEqual([
    ['pr0-synthetic', 'fixed'],
    ['pr0-synthetic', 'fixed'],
  ]);
  const events = f.root.session.snapshotEvents();
  expect(
    events
      .filter((e) => e.type === 'assistant/message')
      .map((e) => e.data.message.content[0].text),
  ).toEqual(['月报已经完成。', '这是已生成的月报下载链接。']);
  const inputs = events.filter((e) => e.type === 'user/message');
  expect(inputs.filter((e) => e.data.source?.kind === 'user')).toHaveLength(1);
  expect(JSON.stringify(events)).toContain('allrice-final-delivery-repair');
  await expect(f.repair(corrected)).rejects.toThrow();
  await f.finish(corrected);
});

it('工具尝试不会执行，修正也不能再派发第二次模型调用', async () => {
  const f = await subject(async (_request, count) =>
    count === 1
      ? text('缺少链接')
      : [
          {
            type: 'tool-call',
            id: 'forbidden',
            name: 'todo_write',
            arguments: { todos: [] },
          },
        ],
  );
  await f.prompt('请给我文件。');
  const original = await f.call('candidate');
  await f.repair(original);
  await expect(f.call('candidate')).rejects.toThrow();
  expect(f.calls).toHaveLength(2);
  expect(
    f.root.session
      .snapshotEvents()
      .filter((e) => e.type === 'tool/result')
      .map((e) => JSON.stringify(e)),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining('FINAL_DELIVERY_REPAIR_TOOLS_FORBIDDEN'),
    ]),
  );
});

it.each([
  ['other Run', (o) => ({ ...o, rootRunId: randomUUID() })],
  ['other session', (o) => ({ ...o, nativeSessionId: 'foreign' })],
  ['unanchored turn', (o) => ({ ...o, starts: [] })],
])('原生 journal 不接受 %s 的来源', async (_name, transform) => {
  const f = await subject(async () => text('完成'), transform);
  await f.prompt('原问题');
  await expect(f.call('candidate')).rejects.toThrow(
    'assistant_completion_origin_unavailable',
  );
});

it('持有完成边界后取消，不能提交旧 proof', async () => {
  const f = await subject(async () => text('完成'));
  await f.prompt('原问题');
  const candidate = await f.call('candidate');
  await f.server.interrupt({ sessionId: f.root.id });
  await expect(f.finish(candidate)).rejects.toThrow();
});

it('修正派发前重新经过 Worker 权限门卫，失租不能调用模型', async () => {
  const f = await subject(
    async () => text('缺少链接'),
    undefined,
    async () => {
      throw Error('lease_lost');
    },
  );
  await f.prompt('请给我月报。');
  const candidate = await f.call('candidate');
  await f.repair(candidate);
  await expect(f.call('candidate')).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});

it('修正进行中取消会中止原生请求，原答复不能冒充修正成功', async () => {
  const entered = gate(),
    release = gate();
  const f = await subject(async (request, count) => {
    if (count === 2) {
      entered.resolve();
      await hold(request.signal, release);
    }
    return text('缺少链接');
  });
  await f.prompt('请给我月报。');
  const candidate = await f.call('candidate');
  await f.repair(candidate);
  await entered.promise;
  await f.server.interrupt({ sessionId: f.root.id });
  await expect(f.call('candidate')).rejects.toThrow();
  await expect(f.finish(candidate)).rejects.toThrow();
  expect(f.calls).toHaveLength(2);
});

it('候选持有后原生日志改变，旧 digest 既不能修正也不能提交', async () => {
  const f = await subject(async () => text('原答复'));
  await f.prompt('请给我月报。');
  const candidate = await f.call('candidate');
  f.root.session.append(
    'assistant/message',
    {
      turn: candidate.turn,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: text('替换后的答复'),
        source: { provider: 'pr0-synthetic', model: 'fixed' },
      }),
    },
    { surfaceOp: 'append' },
  );
  await expect(f.repair(candidate)).rejects.toThrow();
  await expect(f.finish(candidate)).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});

it('后代的结算尚未 flush 时，候选仍等待公开 wait', async () => {
  const f = await subject(async () => text('完成'));
  const entered = gate(),
    released = gate();
  const flush = f.ctx.sessions.flush.bind(f.ctx.sessions);
  f.ctx.sessions.flush = async (session) => {
    if (session.id !== f.root.id) {
      entered.resolve();
      await released.promise;
    }
    return flush(session);
  };
  const activation = f.spawn();
  await entered.promise;
  let returned = false;
  const candidate = f.call('candidate').then((c) => {
    returned = true;
    return c;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(returned).toBe(false);
  released.resolve();
  await activation;
  await f.finish(await candidate);
});
