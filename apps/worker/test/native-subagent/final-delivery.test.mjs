import { setImmediate } from 'node:timers';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createAssistantMessage } from '@deepseek-ai/dsh-llm';
import { host, text, gate, hold } from './fixture.mjs';
import { digestText } from '../../dsh/allrice-final-delivery-repair.mjs';

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
