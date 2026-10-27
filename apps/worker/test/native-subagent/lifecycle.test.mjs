/* global AbortController */
import { describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import {
  noRunningDescendants,
  treeQuiescent,
} from '../../dsh/allrice-agent-tree.mjs';
import { gate, hold, host, text } from './fixture.mjs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { toolResult } from './tool-result.mjs';

describe('PR0 pinned DSH lifecycle on the Worker host', () => {
  it('T1/T14 waits through child settlement and the parent follow-up turn', async () => {
    const childGate = gate(),
      entered = gate(),
      followup = gate(),
      finish = gate();
    const h = await host({
      model: async (request) => {
        if (request.sessionId !== 'pr0-root') {
          entered.resolve();
          await hold(request.signal, childGate);
        } else {
          followup.resolve();
          await hold(request.signal, finish);
        }
        return text('结果');
      },
    });
    const activation = await h.spawn();
    await entered.promise;
    expect(noRunningDescendants(h.root)).toBe(false);
    expect(treeQuiescent(h.root)).toBe(false);
    let returned = false;
    const wait = h.wait().then(() => {
      returned = true;
    });
    childGate.resolve();
    await activation.result;
    await followup.promise;
    expect(returned).toBe(false);
    finish.resolve();
    await wait;
    expect(noRunningDescendants(h.root)).toBe(true);
    expect(treeQuiescent(h.root)).toBe(true);
    expect(
      h.root.session
        .snapshotEvents()
        .filter(
          (e) =>
            e.type === 'user/message' &&
            e.data.source?.kind === 'subagent-settled',
        ),
    ).toHaveLength(1);
  });

  it('T1 does not deliver a settlement to an offline parent', async () => {
    const entered = gate(),
      finish = gate();
    const h = await host({
      model: async (r) => {
        entered.resolve();
        await hold(r.signal, finish);
        return text('child result');
      },
    });
    const handle = await h.ctx.agents.create({
      sessionId: 'offline-parent',
      meta: { cwd: h.directory },
      agentOptions: { provider: 'pr0-synthetic', model: 'fixed' },
    });
    const parent = handle.agent;
    const activation = await h.spawn(parent);
    await entered.promise;
    await handle.dispose();
    finish.resolve();
    await activation.result;
    expect(
      parent.session
        .snapshotEvents()
        .some((e) => JSON.stringify(e.data).includes('subagent-settled')),
    ).toBe(false);
  });

  it.each([false, true])(
    'T6/T19 interrupt with queued inbox=%s follows DSH settlement/parking',
    async (queued) => {
      const entered = gate(),
        finish = gate();
      let held = true;
      let listRequested = false;
      const h = await host({
        active: 1,
        model: async (r) => {
          if (r.sessionId === 'pr0-root' && listRequested) {
            listRequested = false;
            return [
              {
                type: 'tool-call',
                id: 'parked-list',
                name: 'list_agents',
                arguments: '{}',
              },
            ];
          }
          if (r.sessionId !== 'pr0-root' && held) {
            entered.resolve();
            await hold(r.signal, finish);
          }
          return text('子级最后回复');
        },
      });
      const activation = await h.spawn();
      await entered.promise;
      const child = h.ctx.agents.get(activation.childId);
      if (queued) h.inject(child, '下个 step 再处理');
      await h.ctx.subagents.interruptByParent(
        child.id,
        h.root.id,
        'continuable',
      );
      await child.whenIdle();
      await h.wait();
      expect(noRunningDescendants(h.root)).toBe(true);
      expect(treeQuiescent(h.root)).toBe(true);
      if (queued) {
        expect(h.ctx.agents.get(child.id)).toBe(child);
        expect(
          (await h.ctx.subagents.listDescendants(h.root.id))[0].activity,
        ).toBe('running');
        listRequested = true;
        await h.prompt('列出刚才停下的子智能体。');
        await h.wait();
        const result = toolResult(
          h.calls
            .filter((r) => r.sessionId === h.root.id)
            .flatMap((r) => r.messages),
          'parked-list',
        );
        expect(result).toMatchObject({
          isError: false,
          content: text(`${child.id} [inactive] — 子任务`),
        });
        await expect(h.spawn()).rejects.toMatchObject({
          code: 'ACTIVATION_LIMIT_REACHED',
        });
        await h.ctx.subagents.interruptByParent(
          child.id,
          h.root.id,
          'continuable',
        );
        expect(child.inbox.nextStep).toHaveLength(1);
        held = false;
        await h.ctx.subagents.sendMessage(h.root, child.id, text('继续'), {
          signal: new AbortController().signal,
        });
      }
      await activation.result;
      await h.wait();
      expect(h.ctx.agents.get(child.id)).toBeUndefined();
      expect(
        h.root.session
          .snapshotEvents()
          .filter(
            (e) =>
              e.type === 'user/message' &&
              e.data.source?.kind === 'subagent-settled',
          ),
      ).toHaveLength(1);
    },
  );

  it('T10 drains running and parked children before recover restores delegation', async () => {
    let blockChildren = true;
    const h = await host({
      model: async (r) => {
        if (r.sessionId !== 'pr0-root' && blockChildren)
          await hold(r.signal, gate());
        return text('完成');
      },
    });
    const running = await h.spawn(h.root, '运行子级');
    const parked = await h.spawn(h.root, '停放子级');
    await expect.poll(() => h.calls.length).toBe(2);
    const parkedAgent = h.ctx.agents.get(parked.childId);
    h.inject(parkedAgent, '待续消息');
    await h.ctx.subagents.interruptByParent(
      parked.childId,
      h.root.id,
      'continuable',
    );
    await parkedAgent.whenIdle();
    await h.ctx.subagents.drainDescendants([h.root]);
    await Promise.all([running.result, parked.result]);
    for (const child of [running, parked])
      expect(h.ctx.agents.get(child.childId)).toBeUndefined();
    await expect(h.spawn()).rejects.toMatchObject({ code: 'DRAINING' });
    await h.server.handleRequest('session/recover', { sessionId: h.root.id });
    const recovered = h.ctx.agents.get(h.root.id);
    expect(recovered).not.toBe(h.root);
    await setImmediate();
    expect(h.calls).toHaveLength(2);
    expect(recovered.status).toBe('idle');
    expect([...recovered.inbox.nextStep, ...recovered.inbox.nextTurn]).toEqual(
      [],
    );
    blockChildren = false;
    await (
      await h.spawn(recovered, '恢复后的委派')
    ).result;
    await h.wait();
    expect(treeQuiescent(recovered)).toBe(true);
  });

  it('T14 separates durable root inbox from running descendants', async () => {
    const h = await host();
    h.inject(h.root, '已结算子级的持久通知');
    expect(noRunningDescendants(h.root)).toBe(true);
    expect(treeQuiescent(h.root)).toBe(false);
    h.root.inbox.clear();
    h.root.inbox.append('next-turn', {
      id: 'queued',
      role: 'user',
      content: text('下一轮'),
    });
    expect(treeQuiescent(h.root)).toBe(false);
    h.root.inbox.clear();
    expect(treeQuiescent(h.root)).toBe(true);
  });

  it('T14 ignores unrelated roots and follows ownership through an idle parent', async () => {
    const entered = gate();
    const h = await host({
      model: async (r) => {
        entered.resolve();
        await hold(r.signal, gate());
        return text('完成');
      },
    });
    const options = { provider: 'pr0-synthetic', model: 'fixed' };
    const other = await h.ctx.agents.create({
      sessionId: 'other-root',
      meta: { cwd: h.directory },
      agentOptions: options,
    });
    const child = await h.ctx.agents.create({
      sessionId: 'idle-parent',
      parentAgent: h.root,
      meta: { cwd: h.directory },
      agentOptions: options,
    });
    const grandchild = await h.ctx.agents.create({
      sessionId: 'grandchild',
      parentAgent: child.agent,
      meta: { cwd: h.directory },
      agentOptions: options,
    });
    try {
      other.agent.followup(
        createUserMessage({
          content: text('其他根'),
          source: { kind: 'user' },
        }),
      );
      await entered.promise;
      expect(noRunningDescendants(h.root)).toBe(true);
      grandchild.agent.followup(
        createUserMessage({
          content: text('孙级任务'),
          source: { kind: 'user' },
        }),
      );
      await expect.poll(() => grandchild.agent.status).toBe('running');
      expect(child.agent.status).toBe('idle');
      expect(noRunningDescendants(h.root)).toBe(false);
    } finally {
      await grandchild.dispose();
      await child.dispose();
      await other.dispose();
    }
  });

  it('T14 nonblocking observations do not cover in-flight creation; SDK wait does', async () => {
    const creating = gate(),
      admit = gate();
    const h = await host();
    h.ctx.on('agent/created', async ({ agent }) => {
      if (agent.session.header.origin === 'subagent') {
        creating.resolve();
        await admit.promise;
      }
    });
    const start = h.spawn();
    await creating.promise;
    expect(noRunningDescendants(h.root)).toBe(true);
    expect(treeQuiescent(h.root)).toBe(true);
    let returned = false;
    const waiting = h.wait().then(() => {
      returned = true;
    });
    try {
      await setImmediate(); // The creation gate stays closed across an event-loop turn.
      expect(returned).toBe(false);
    } finally {
      admit.resolve();
      await (
        await start
      ).result;
      await waiting;
    }
  });

  it('T14 idle-before-settlement snapshots can pass while session/wait is pending', async () => {
    const entered = gate(),
      finish = gate(),
      flushing = gate(),
      releaseFlush = gate();
    const h = await host({
      model: async (r) => {
        if (r.sessionId !== 'pr0-root') {
          entered.resolve();
          await hold(r.signal, finish);
        }
        return text('子级结果');
      },
    });
    const activation = await h.spawn();
    await entered.promise;
    const child = h.ctx.agents.get(activation.childId);
    h.ctx.on('session/flush', async (session) => {
      if (session.id === child.id && child.status === 'idle') {
        flushing.resolve();
        await releaseFlush.promise;
      }
    });
    let returned = false;
    const waiting = h.wait().then(() => {
      returned = true;
    });
    finish.resolve();
    try {
      await flushing.promise;
      await setImmediate();
      expect(child.status).toBe('idle');
      expect(h.ctx.agents.get(child.id)).toBe(child);
      expect([...h.root.inbox.nextStep, ...h.root.inbox.nextTurn]).toEqual([]);
      expect(
        h.root.session
          .snapshotEvents()
          .some((e) => JSON.stringify(e.data).includes('subagent-settled')),
      ).toBe(false);
      expect(noRunningDescendants(h.root)).toBe(true);
      expect(treeQuiescent(h.root)).toBe(true);
      expect(returned).toBe(false);
    } finally {
      releaseFlush.resolve();
    }
    await activation.result;
    await waiting;
    expect(
      h.root.session
        .snapshotEvents()
        .filter(
          (e) =>
            e.type === 'user/message' &&
            e.data.source?.kind === 'subagent-settled',
        ),
    ).toHaveLength(1);
  });

  it('T14 session/wait can finish before concurrent recover disposes the old root', async () => {
    const entered = gate();
    const h = await host({
      model: async (r) => {
        if (r.sessionId !== 'pr0-root') {
          entered.resolve();
          await hold(r.signal, gate());
        }
        return text('完成');
      },
    });
    const child = await h.spawn();
    await entered.promise;
    const waiting = h.wait().then(
      () => ({ resolved: true }),
      (error) => ({ error: error.message }),
    );
    await h.server.handleRequest('session/recover', { sessionId: h.root.id });
    // Observed 0.2.1-rc.2 ordering, not a guarantee for future DSH versions.
    expect(await waiting).toEqual({ resolved: true });
    const recovered = h.ctx.agents.get(h.root.id);
    expect(recovered).not.toBe(h.root);
    expect(h.ctx.agents.get(child.childId)).toBeUndefined();
    await setImmediate();
    expect(h.calls).toHaveLength(1);
    expect(recovered.status).toBe('idle');
    // keepInbox applies to closeRoot's first cancel. DSH's later handle.dispose
    // cancels pending inbox again: both insertion and cancellation are durable.
    const splices = recovered.session
      .snapshotEvents()
      .filter((e) => e.type === 'agent/inbox/spliced');
    expect(splices.map((e) => e.data)).toMatchObject([
      {
        inserted: [
          {
            source: {
              kind: 'subagent-settled',
              senderSessionId: child.childId,
            },
          },
        ],
      },
      { inserted: [], removedCount: 1, outcome: 'canceled' },
    ]);
    expect([...recovered.inbox.nextStep, ...recovered.inbox.nextTurn]).toEqual(
      [],
    );
  });
});
