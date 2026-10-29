import { randomUUID } from 'node:crypto';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { gate, hold, host, text } from './fixture.mjs';

const runId = 'b5834c57-e579-4794-a4b2-e9b94e5dd4bd';
const bridge = async (method) => {
  if (method !== 'allrice/run-authorize') throw Error(method);
  return { allowed: true };
};

it('PR3a observes actual child and grandchild identity before model admission', async () => {
  const finish = gate(),
    entered = gate();
  const requests = [];
  const h = await host({
    runId,
    depth: 2,
    bridge: async (method, params) => {
      requests.push(params);
      return bridge(method);
    },
    model: async (r) => {
      entered.resolve();
      await hold(r.signal, finish);
      return text('完成');
    },
  });
  const child = await h.spawn();
  await entered.promise;
  const childAgent = h.ctx.agents.get(child.childId);
  const grandchild = await h.spawn(childAgent);
  finish.resolve();
  await Promise.all([child.result, grandchild.result]);
  await h.wait();
  for (const [id, parent, depth] of [
    [child.childId, h.root.id, 1],
    [grandchild.childId, child.childId, 2],
  ]) {
    const value = {
      runId,
      nativeSessionId: id,
      rootSessionId: h.root.id,
      parentSessionId: parent,
      delegationDepth: depth,
    };
    expect(h.notices).toContainEqual({
      method: 'allrice.run-session',
      params: value,
    });
    expect(requests).toContainEqual(expect.objectContaining(value));
  }
});

it('PR3a rejects outside and symlink cwd before a child model request', async () => {
  const h = await host({ runId, bridge });
  await symlink('/', join(h.directory, 'outside'));
  for (const cwd of ['/', join(h.directory, 'outside')]) {
    await expect(
      h.spawn(h.root, '越界工作目录', {
        request: { parent: h.root, prompt: text('越界工作目录'), cwd },
      }),
    ).rejects.toThrow('RUN_CWD_DENIED');
  }
  expect(h.calls).toHaveLength(0);
});

it('PR3a no active Run blocks native wakeups and wrong-Run inputs', async () => {
  const h = await host({ runId, bridge });
  await h.server.handleRequest('run/end', { sessionId: h.root.id, runId });
  h.root.steer(
    createUserMessage({ content: text('迟到唤醒'), source: { kind: 'user' } }),
  );
  await h.root.whenIdle();
  expect(h.calls).toHaveLength(0);
  await expect(h.prompt('没有活跃任务')).rejects.toThrow('RUN_NOT_ACTIVE');
  await h.server.handleRequest('run/begin', { sessionId: h.root.id, runId });
  await expect(
    h.server.handleRequest('session/steer', {
      sessionId: h.root.id,
      runId: randomUUID(),
      text: '串入其他 Run',
    }),
  ).rejects.toThrow('RUN_NOT_ACTIVE');
});

it('PR3a Run steer crosses native turns, records actual adoption, and closes at wait', async () => {
  const childEntered = gate(),
    childRelease = gate(),
    secondEntered = gate(),
    secondRelease = gate();
  let roots = 0;
  const h = await host({
    runId,
    bridge,
    model: async (r) => {
      if (r.sessionId !== 'pr0-root') {
        childEntered.resolve();
        await hold(r.signal, childRelease);
        return text('子任务结果');
      }
      if (++roots === 2) {
        secondEntered.resolve();
        await hold(r.signal, secondRelease);
      }
      return text('主任务结果');
    },
  });
  await h.spawn();
  await childEntered.promise;
  await h.prompt('请派子任务，完成后汇总。');
  await h.root.whenIdle();
  const waiting = h.wait();
  childRelease.resolve();
  await secondEntered.promise;
  const input = {
    sessionId: h.root.id,
    runId,
    inputId: randomUUID(),
    turnId: `${h.root.id}:turn:1`,
    kind: 'steer_current',
    text: '汇总时加上城市名称。',
  };
  expect(await h.server.handleRequest('session/steer', input)).toMatchObject({
    status: 'pending',
  });
  secondRelease.resolve();
  await waiting;
  // Receipt lookup stays available without reopening ingress after completion.
  expect(await h.server.handleRequest('session/steer', input)).toMatchObject({
    status: 'adopted',
    runId,
    turnId: `${h.root.id}:turn:2`,
  });
  await expect(
    h.server.handleRequest('session/steer', {
      ...input,
      inputId: randomUUID(),
    }),
  ).rejects.toThrow('RUN_COMPLETING');
  // Cold-reader validation must accept the exact existing journal contract.
  await h.server.handleRequest('session/recover', { sessionId: h.root.id });
  expect(h.server.requireRoot(h.root.id).agent).not.toBe(h.root);
});

it('PR3a stop drains descendants before clearing root inbox; recover can delegate again', async () => {
  const entered = gate();
  const h = await host({
    runId,
    bridge,
    model: async (r) => {
      if (r.sessionId !== 'pr0-root') {
        entered.resolve();
        await hold(r.signal, gate());
      }
      return text('根回复');
    },
  });
  const child = await h.spawn();
  await entered.promise;
  h.inject(h.root, '取消前的排队消息');
  await h.server.handleRequest('session/interrupt', { sessionId: h.root.id });
  expect(h.ctx.agents.get(child.childId)).toBeUndefined();
  expect(h.ctx.agents.get(h.root.id)).not.toBe(h.root);
  expect(
    h.root.session
      .snapshotEvents()
      .some(
        (e) =>
          e.type === 'agent/inbox/spliced' && e.data.outcome === 'canceled',
      ),
  ).toBe(true);
  await h.server.handleRequest('run/end', { sessionId: h.root.id, runId });
  await h.server.handleRequest('run/begin', {
    sessionId: h.root.id,
    runId: randomUUID(),
  });
  const root = h.server.requireRoot(h.root.id).agent;
  expect(root.inbox.nextTurn).toHaveLength(0);
  const again = await h.spawn(root);
  expect(h.ctx.agents.get(again.childId)).toBeDefined();
});
