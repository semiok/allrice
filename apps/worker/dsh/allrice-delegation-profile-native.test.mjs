/* global AbortController */
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { gate, hold, host, text } from '../test/native-subagent/fixture.mjs';

it('the sealed production composition exposes all five tools and uses native child messages, interrupt and continuation', async () => {
  const entered = gate(),
    blocked = gate(),
    receipts = [];
  let h,
    rootCalls = 0,
    childCalls = 0,
    childId;
  const call = (name, args) => [
    {
      type: 'tool-call',
      id: randomUUID(),
      name,
      arguments: JSON.stringify(args),
    },
  ];
  h = await host({
    productionProfile: 'allrice-restricted',
    runId: randomUUID(),
    accounting: true,
    prepare: async () =>
      vi.stubEnv(
        'ALLRICE_NATIVE_SUBAGENTS',
        JSON.stringify({ maxDepth: 2, maxActiveSubagents: 3 }),
      ),
    bridge: async (method, params) => {
      if (method === 'allrice/run-authorize') return { allowed: true };
      if (method === 'allrice/model-receipt') {
        receipts.push(params);
        return {};
      }
      throw Error(`unexpected bridge ${method}`);
    },
    model: async (request) => {
      if (request.sessionId !== h.root.id) {
        childId = request.sessionId;
        if (++childCalls === 1) {
          entered.resolve();
          await hold(request.signal, blocked);
        }
        if (childCalls === 2)
          return call('send_message', {
            agent_id: h.root.id,
            message: '子级已原生续接',
          });
        return text('子级最终结果');
      }
      rootCalls++;
      if (rootCalls === 1)
        return call('subagent', {
          description: '控制验收',
          prompt: '完成独立核对',
        });
      if (rootCalls === 2) return call('list_agents', {});
      if (rootCalls === 3) {
        await entered.promise;
        return call('interrupt_agent', { agent_id: childId });
      }
      if (rootCalls === 4)
        return call('send_message', {
          agent_id: childId,
          message: '请继续并回父级',
        });
      return text('已汇总结果');
    },
  });
  await h.prompt('启动子级，再停止并继续，最后汇总。');
  await h.wait();
  await h.server.nativeAccounting.flush();
  expect(h.ctx.subagents.resolveMaxDepth()).toBe(2);
  const schemas = h.calls[0].tools;
  expect(schemas.map((s) => s.name)).toEqual(
    expect.arrayContaining([
      'subagent',
      'subagent_fork',
      'list_agents',
      'send_message',
      'interrupt_agent',
    ]),
  );
  expect(
    schemas.find((s) => s.name === 'subagent').parameters.properties,
  ).not.toHaveProperty('model');
  expect(
    h.root.session
      .snapshotEvents()
      .some(
        (e) =>
          e.type === 'user/message' &&
          e.data.source?.kind === 'agent-message' &&
          e.data.source.senderSessionId === childId,
      ),
  ).toBe(true);
  expect(
    h.root.session
      .snapshotEvents()
      .some(
        (e) =>
          e.type === 'user/message' &&
          e.data.source?.kind === 'subagent-settled',
      ),
  ).toBe(true);
  expect(
    h.calls.some((r) =>
      JSON.stringify(r.messages).includes('Current runtime context.'),
    ),
  ).toBe(true);
  expect(receipts.filter((p) => p.fact?.phase === 'start')).toHaveLength(
    h.calls.length,
  );
  expect(receipts.at(-1).delivery).toEqual({
    calls: h.calls.length,
    complete: true,
  });
});

it('the production profile keeps native default capacity eight and permits sequential reuse without a cumulative limit', async () => {
  const release = gate();
  const h = await host({
    productionProfile: 'allrice-restricted',
    runId: randomUUID(),
    prepare: async () => vi.stubEnv('ALLRICE_NATIVE_SUBAGENTS', '{}'),
    bridge: async (method) => {
      if (method === 'allrice/run-authorize') return { allowed: true };
      throw Error(`unexpected bridge ${method}`);
    },
    model: async (request) => {
      if (request.sessionId !== 'pr0-root') await hold(request.signal, release);
      return text('完成');
    },
  });
  expect(h.ctx.subagents.resolveMaxDepth()).toBe(1);
  const active = await Promise.all(Array.from({ length: 8 }, () => h.spawn()));
  await expect(h.spawn()).rejects.toThrow();
  expect(await h.ctx.subagents.listDescendants(h.root.id)).toHaveLength(8);
  release.resolve();
  await Promise.all(active.map((child) => child.result));
  await h.wait();
  for (let i = 0; i < 6; i++) {
    await (
      await h.spawn()
    ).result;
    await h.wait();
  }
  expect(await h.ctx.subagents.listDescendants(h.root.id)).toHaveLength(14);
});
