import { expect, it } from 'vitest';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  noRunningDescendants,
  treeQuiescent,
} from '../../dsh/allrice-agent-tree.mjs';
import { gate, hold, host, text } from './fixture.mjs';

const call = (id, name, args) => ({
  type: 'tool-call',
  id,
  name,
  arguments: JSON.stringify(args),
});

it('T3/T17 defaults admit eight concurrent children; the ninth error reaches the model unchanged', async () => {
  const finish = gate(),
    parentStep = gate();
  let rootSteps = 0;
  const h = await host({
    model: async (r) => {
      if (r.sessionId !== 'pr0-root') {
        await hold(r.signal, finish);
        return text('子级结果');
      }
      if (++rootSteps === 1)
        return Array.from({ length: 9 }, (_, i) =>
          call(`delegate-${i}`, 'subagent', {
            description: `task ${i}`,
            prompt: `任务 ${i}`,
          }),
        );
      parentStep.resolve(r);
      return text('已接到工具结果');
    },
  });
  await h.prompt('请同时派九个子智能体，各自报告一个省会。');
  const next = await parentStep.promise;
  expect(h.ctx.agents.list().filter((a) => a !== h.root)).toHaveLength(8);
  expect(JSON.stringify(next.messages)).toContain(
    'subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents',
  );
  finish.resolve();
  await h.wait();
  expect(
    h.root.session
      .snapshotEvents()
      .filter((e) => e.type === 'subagent/catalog'),
  ).toHaveLength(8);
  for (let i = 0; i < 6; i++) {
    await (
      await h.spawn()
    ).result;
    await h.wait();
  }
  expect(
    h.root.session
      .snapshotEvents()
      .filter((e) => e.type === 'subagent/catalog'),
  ).toHaveLength(14);
}, 15000);

it('T3 volatile loader updates preserve the service and change the next admission', async () => {
  const finish = gate(),
    entered = gate();
  const h = await host({
    depth: 2,
    active: 2,
    model: async (r) => {
      if (r.sessionId !== 'pr0-root') {
        entered.resolve();
        await hold(r.signal, finish);
      }
      return text('完成');
    },
  });
  expect(h.ctx.subagents.resolveMaxDepth()).toBe(2);
  const first = await h.spawn();
  await entered.promise;
  const entry = [...h.ctx.loader.entries()].find(
    (e) => e.options.id === 'subagents',
  );
  const fiber = entry.fiber;
  expect(!!fiber).toBe(true);
  await entry.update({ config: { maxDepth: 0, maxActiveSubagents: 1 } });
  await h.ctx.loader.await();
  expect(entry.fiber === fiber).toBe(true);
  expect(h.ctx.subagents.resolveMaxDepth()).toBe(0);
  expect(h.ctx.agents.get(first.childId)).toBeDefined();
  await expect(h.spawn()).rejects.toMatchObject({
    code: 'ACTIVATION_LIMIT_REACHED',
  });
  await entry.update({ config: { maxDepth: 3, maxActiveSubagents: 2 } });
  await h.ctx.loader.await();
  const second = await h.spawn();
  finish.resolve();
  await Promise.all([first.result, second.result]);
  await h.wait();
});

it.each([
  [0, 1],
  [2, 3],
])(
  'T3 cold loader reads env depth=%s and capacity=%s, not defaults',
  async (depth, active) => {
    const h = await host({
      depth,
      active,
      model: async (r) => {
        await hold(r.signal, gate());
        return text('unreachable');
      },
    });
    expect(h.ctx.subagents.resolveMaxDepth()).toBe(depth);
    for (let i = 0; i < active; i++) await h.spawn();
    await expect(h.spawn()).rejects.toMatchObject({
      code: 'ACTIVATION_LIMIT_REACHED',
    });
    // startActivation is a host API: depth is passed by the native tool, not
    // implicitly imposed on callers omitting request.maxDepth.
  },
);

it('T3/T17 depth zero keeps the tool visible and returns DSH depth text to the next model step', async () => {
  const seen = [];
  const h = await host({
    depth: 0,
    model: async (r) => {
      seen.push(r);
      return seen.length === 1
        ? [
            call('delegate', 'subagent', {
              description: 'task',
              prompt: '子任务',
            }),
          ]
        : text('自己完成');
    },
  });
  await h.prompt('请派一个子智能体查茶叶产地。');
  await h.wait();
  expect(JSON.stringify(seen[0].tools)).toContain('subagent');
  expect(JSON.stringify(seen[1].messages)).toContain(
    'subagent depth 1 exceeds maxDepth 0',
  );
  expect(await h.ctx.subagents.listChildren(h.root.id)).toEqual([]);
});

it('T2/T4 global guard and LLM middleware see children and grandchildren after agent/created', async () => {
  const observations = [],
    steps = new Map(),
    entered = gate(),
    finish = gate();
  const h = await host({
    depth: 2,
    model: async (r) => {
      const count = (steps.get(r.sessionId) ?? 0) + 1;
      steps.set(r.sessionId, count);
      if (r.sessionId === 'pr0-root') return text('主级完成');
      if (count === 1) return [call(`probe-${r.sessionId}`, 'pr0_probe', {})];
      entered.resolve();
      await hold(r.signal, finish);
      return text('后代完成');
    },
  });
  h.ctx.tools.register(
    defineTool({
      name: 'pr0_probe',
      description: 'Offline guard probe',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async () => 'ok',
    }),
  );
  h.ctx.tools.guard((exec) => {
    observations.push(['guard', exec.agent.id]);
  });
  h.ctx.on('agent/created', ({ agent }) => {
    observations.push(['created', agent.id]);
  });
  h.ctx.on('agent/request', async ({ agent }, next) => {
    observations.push(['request', agent.id]);
    return next();
  });
  h.ctx.on('llm/stream', async function* (request, next) {
    observations.push(['llm', request.sessionId]);
    yield* next();
  });
  h.ctx.on('subagent/start', (info) => {
    observations.push(['start', info.id]);
  });
  h.ctx.on('subagent/end', (info) => {
    observations.push(['end', info.id]);
  });
  const child = await h.spawn();
  await entered.promise;
  const childAgent = h.ctx.agents.get(child.childId);
  const grandchild = await h.spawn(childAgent);
  await expect
    .poll(() =>
      observations.some(
        ([kind, id]) => kind === 'guard' && id === grandchild.childId,
      ),
    )
    .toBe(true);
  expect(noRunningDescendants(h.root)).toBe(false);
  finish.resolve();
  await Promise.all([child.result, grandchild.result]);
  await h.wait();
  for (const id of [child.childId, grandchild.childId]) {
    expect(
      observations.filter(([, agent]) => agent === id).map(([kind]) => kind),
    ).toEqual(
      expect.arrayContaining([
        'created',
        'request',
        'llm',
        'guard',
        'start',
        'end',
      ]),
    );
    expect(
      observations.findIndex(([k, a]) => k === 'created' && a === id),
    ).toBeLessThan(
      observations.findIndex(([k, a]) => k === 'request' && a === id),
    );
  }
  expect(treeQuiescent(h.root)).toBe(true);
});

it('T8 native cwd accepts an outside directory; the future tenant guard must own that check', async () => {
  const entered = gate(),
    finish = gate();
  const h = await host({
    model: async (r) => {
      if (r.sessionId !== 'pr0-root') {
        entered.resolve();
        await hold(r.signal, finish);
      }
      return text('完成');
    },
  });
  const child = await h.spawn(h.root, 'cwd probe', {
    request: { parent: h.root, prompt: text('cwd probe'), cwd: '/' },
  });
  await entered.promise;
  const agent = h.ctx.agents.get(child.childId);
  expect(h.ctx.workingDirectory.get(agent.session)).toBe('/');
  expect(agent.session.header.cwd).toBe(h.directory);
  finish.resolve();
  await child.result;
  await h.wait();
});
