import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { withEmployeeCustomizationTools } from '@allrice/contracts';
import { gate, hold, host, text } from './fixture.mjs';

const runId = 'b5834c57-e579-4794-a4b2-e9b94e5dd4bd';
const bridge = async (method) => {
  if (method !== 'allrice/run-authorize') throw Error(method);
  return { allowed: true };
};

it('new Rice root and actual spawned child omit retired method schemas while retaining granted web fetch', async () => {
  const retired = ['inspect', 'save_candidate', 'restore_candidate'];
  const nativeTools = withEmployeeCustomizationTools(
    ['web.fetch'],
    ['storage:read', 'storage:write', 'network:outbound'],
    'general',
  );
  const h = await host({ runId, nativeTools, bridge });
  await h.prompt('请核对公开资料，并把来源检查交给子任务。');
  await h.wait();
  const child = await h.spawn(h.root, '检查公开资料来源');
  await child.result;
  await h.wait();
  expect(child.childId).not.toBe(h.root.id);
  const schemas = [];
  for (const id of [h.root.id, child.childId]) {
    const request = h.calls.find((call) => call.sessionId === id);
    expect(request).toBeDefined();
    const names = request.tools.map((tool) => tool.name).sort();
    expect(names).toContain('web_fetch');
    for (const action of retired)
      expect(names).not.toContain(`workspace_employee_method_${action}`);
    schemas.push({ sessionId: id, names });
  }
  console.log(
    'LEGACY_METHOD_RETIREMENT_NATIVE_SCHEMAS',
    JSON.stringify({ nativeTools, schemas }),
  );
});

it('profile writes reach the Broker only from the actual live root, never a child sharing its Run', async () => {
  const calls = [],
    steps = new Map(),
    childResults = [];
  const profileCall = (id) => ({
    type: 'tool-call',
    id,
    name: 'workspace_employee_profile_update',
    arguments: JSON.stringify({
      expectedRevision: 1,
      expressionStyle: 'concise',
    }),
  });
  const h = await host({
    runId,
    nativeTools: ['workspace.employee.profile.update'],
    rootSystemInstructions: 'ROOT_STABLE',
    employeeDocuments: {
      persona: 'SAME_EMPLOYEE_PERSONA',
      user: 'ROOT_USER_ONLY',
      memory: 'ROOT_MEMORY_ONLY',
    },
    bridge: async (method, params) => {
      if (method === 'allrice/run-authorize') return { allowed: true };
      if (method !== 'allrice/tool-call') throw Error(method);
      calls.push(params);
      return { modelContent: '{"revision":2}', summary: 'Saved by root' };
    },
    model: async (request) => {
      const step = (steps.get(request.sessionId) ?? 0) + 1;
      steps.set(request.sessionId, step);
      if (request.sessionId !== 'pr0-root') {
        if (step === 1) return [profileCall('child-profile')];
        childResults.push(JSON.stringify(request.messages));
        return text('子任务已完成');
      }
      if (step === 1)
        return [
          {
            type: 'tool-call',
            id: 'delegate-profile',
            name: 'subagent',
            arguments: JSON.stringify({
              description: '资料来源检查',
              prompt: '以后回答保持简洁。',
            }),
          },
        ];
      if (step === 2) return [profileCall('root-profile')];
      return text('本轮完成');
    },
  });
  await h.prompt('以后回答保持简洁。');
  await h.wait();
  expect(calls).toEqual([
    expect.objectContaining({
      nativeSessionId: h.root.id,
      toolCallId: 'root-profile',
      name: 'workspace.employee.profile.update',
      arguments: { expectedRevision: 1, expressionStyle: 'concise' },
    }),
  ]);
  expect(childResults).toHaveLength(1);
  expect(childResults[0]).toContain('EMPLOYEE_PROFILE_ROOT_REQUIRED');
  expect(childResults[0]).toContain('SAME_EMPLOYEE_PERSONA');
  expect(childResults[0]).not.toContain('ROOT_USER_ONLY');
  expect(childResults[0]).not.toContain('ROOT_MEMORY_ONLY');
});

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
  const h = await host({
    runId,
    bridge,
    rootSystemInstructions: 'ROOT_STABLE',
    employeeDocuments: { persona: 'ADMITTED_PERSONA', user: '', memory: '' },
  });
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
  const h = await host({
    runId,
    bridge,
    rootSystemInstructions: 'ROOT_STABLE',
    employeeDocuments: { persona: 'ADMITTED_PERSONA', user: '', memory: '' },
  });
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

it('run/begin rejects invalid documents and foreign roots before admitting or exposing a stale document binding', async () => {
  const h = await host({
    runId,
    bridge,
    rootSystemInstructions: 'ROOT_STABLE',
    employeeDocuments: { persona: 'OLD_PERSONA', user: '', memory: '' },
  });
  await h.server.handleRequest('run/end', { runId });
  const notices = h.notices.length;
  await expect(
    h.server.handleRequest('run/begin', {
      sessionId: h.root.id,
      runId,
      employeeDocuments: { persona: '人'.repeat(5500), user: '', memory: '' },
    }),
  ).rejects.toThrow();
  expect(h.notices).toHaveLength(notices);
  await expect(h.prompt('无效快照不可开始任务')).rejects.toThrow(
    'RUN_NOT_ACTIVE',
  );
  await expect(
    h.server.handleRequest('run/begin', {
      sessionId: 'foreign-root',
      runId,
      employeeDocuments: { persona: 'FOREIGN_PERSONA', user: '', memory: '' },
    }),
  ).rejects.toThrow('HOST_SINGLE_ROOT_REQUIRED');
  await expect(h.prompt('外来根不可建立绑定')).rejects.toThrow(
    'RUN_NOT_ACTIVE',
  );
  expect(h.calls).toHaveLength(0);
  await h.server.handleRequest('run/begin', {
    sessionId: h.root.id,
    runId,
    employeeDocuments: { persona: 'CURRENT_PERSONA', user: '', memory: '' },
  });
  const child = await h.spawn();
  await child.result;
  await h.wait();
  const request = h.calls.find((r) => r.sessionId === child.childId);
  expect(JSON.stringify(request.messages)).toContain('CURRENT_PERSONA');
  expect(JSON.stringify(request.messages)).not.toContain('OLD_PERSONA');
  expect(JSON.stringify(request.messages)).not.toContain('FOREIGN_PERSONA');
}, 30000);

it('run/begin rejects a missing document provider without leaving an active Run', async () => {
  const h = await host({ runId, bridge });
  await h.server.handleRequest('run/end', { runId });
  await expect(
    h.server.handleRequest('run/begin', {
      sessionId: h.root.id,
      runId,
      employeeDocuments: { persona: 'UNBOUND_PERSONA', user: '', memory: '' },
    }),
  ).rejects.toThrow('EMPLOYEE_DOCUMENT_PROVIDER_REQUIRED');
  await expect(h.prompt('缺少 provider 不可开始任务')).rejects.toThrow(
    'RUN_NOT_ACTIVE',
  );
  expect(h.calls).toHaveLength(0);
  await h.server.handleRequest('run/begin', { sessionId: h.root.id, runId });
  await h.prompt('原有非文档任务继续可用');
  await h.wait();
  expect(h.calls).toHaveLength(1);
}, 30000);

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
