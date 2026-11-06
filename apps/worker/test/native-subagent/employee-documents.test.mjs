/* global AbortController */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import { expect, it, vi } from 'vitest';
import { gate, hold, host, text } from './fixture.mjs';

const runtimeContexts = (request) =>
  request.messages.filter(
    (message) =>
      message.role === 'user' &&
      (JSON.stringify(message.content).includes(
        'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
      ) ||
        JSON.stringify(message.content).includes(
          'Current runtime context: none. Earlier runtime-context snapshots no longer apply.',
        )),
  );
const currentContext = (request) => runtimeContexts(request).at(-1);

it('native first child and nested child receive literal PERSONA only; root documents and native persona/tools/approval/history keep their boundaries', async () => {
  const runId = randomUUID();
  const observedAgents = new Map();
  const entered = gate(),
    release = gate();
  let holdFirstChild = true;
  const h = await host({
    model: async (request) => {
      observedAgents.set(
        request.sessionId,
        h.ctx.agents.get(request.sessionId),
      );
      if (request.sessionId !== 'pr0-root' && holdFirstChild) {
        holdFirstChild = false;
        entered.resolve();
        await hold(request.signal, release);
      }
      return text('完成');
    },
    runId,
    depth: 2,
    rootSystemInstructions: 'ROOT_STABLE_PERSONA',
    employeeDocuments: {
      persona: '# PERSONA.md\nPERSONA_A {{missing}}',
      user: '# USER.md\nPERSON {{missing}}',
      memory: '# MEMORY.md\nCONFIRMED_A',
    },
    prepare: async () => {
      vi.stubEnv('DSH_SYSTEM_PROMPT', 'LEGACY_CHILD_PERSONA');
      vi.stubEnv('ALLRICE_NATIVE_SUBAGENTS', undefined);
    },
    bridge: async (method) => {
      if (method === 'allrice/run-authorize') return { allowed: true };
      throw Error(`unexpected ${method}`);
    },
  });
  await h.prompt('完成根任务');
  await h.wait();
  const rootRequest = h.calls.find((r) => r.sessionId === h.root.id);
  expect(JSON.stringify(rootRequest.messages)).toContain('ROOT_STABLE_PERSONA');
  expect(JSON.stringify(rootRequest.messages)).not.toContain(
    'LEGACY_CHILD_PERSONA',
  );
  expect(JSON.stringify(rootRequest.messages)).toContain('PERSON {{missing}}');
  const requiredContext = rootRequest.messages.find(
    (message) =>
      message.role === 'user' &&
      JSON.stringify(message.content).includes(
        'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
      ),
  );
  expect(JSON.stringify(requiredContext)).toContain('PERSONA_A {{missing}}');
  expect(
    JSON.stringify(rootRequest.messages.filter((m) => m.role === 'system')),
  ).not.toContain('PERSONA_A');
  const child = await h.spawn();
  await entered.promise;
  const childRequest = h.calls.find((r) => r.sessionId === child.childId);
  expect(JSON.stringify(childRequest.messages)).toContain(
    'LEGACY_CHILD_PERSONA',
  );
  expect(JSON.stringify(childRequest.messages)).not.toContain('CONFIRMED_A');
  expect(JSON.stringify(childRequest.messages)).not.toContain(
    'PERSON {{missing}}',
  );
  expect(JSON.stringify(currentContext(childRequest))).toContain(
    'PERSONA_A {{missing}}',
  );
  expect(
    JSON.stringify(childRequest.messages.filter((m) => m.role === 'system')),
  ).not.toContain('PERSONA_A');
  const childAgent = observedAgents.get(child.childId);
  const approval = childAgent.session
    .snapshotEvents()
    .filter((e) => e.type === 'approval/policy');
  expect(approval.map((e) => e.data.policy)).toContain('never');
  const nested = await h.spawn(childAgent, '本人嵌套子任务');
  await nested.result;
  const nestedRequest = h.calls.find((r) => r.sessionId === nested.childId);
  expect(JSON.stringify(currentContext(nestedRequest))).toContain(
    'PERSONA_A {{missing}}',
  );
  expect(JSON.stringify(nestedRequest.messages)).not.toContain('CONFIRMED_A');
  expect(JSON.stringify(nestedRequest.messages)).not.toContain(
    'PERSON {{missing}}',
  );
  release.resolve();
  await child.result;
  await h.wait();
  const forked = await h.spawn(h.root, '原生分叉', { provider: 'fork' });
  await forked.result;
  await h.wait();
  const forkRequest = h.calls.find((r) => r.sessionId === forked.childId);
  expect(JSON.stringify(forkRequest.messages)).toContain('CONFIRMED_A');
  expect(JSON.stringify(forkRequest.messages)).toContain(
    'PERSONA_A {{missing}}',
  );
  expect(
    JSON.stringify(
      forkRequest.messages.filter((m) => m.role === 'system').at(-1),
    ),
  ).toContain('LEGACY_CHILD_PERSONA');
  // Native cold continuation keeps this child Session's system/tools.
  h.server.employeeDocuments.bind(h.root.id, {
    user: '',
    memory: '# MEMORY.md\nCONFIRMED_B',
  });
  await h.ctx.subagents.sendMessage(h.root, child.childId, text('继续'), {
    signal: new AbortController().signal,
  });
  await h.wait();
  const last = h.calls.filter((r) => r.sessionId === child.childId).at(-1);
  expect(JSON.stringify(currentContext(last))).not.toContain('PERSONA_A');
  expect(last.tools).toEqual(childRequest.tools);
  expect(last.messages.filter((m) => m.role === 'system').at(-1)).toEqual(
    childRequest.messages.filter((m) => m.role === 'system').at(-1),
  );
  expect(JSON.stringify(last.messages)).not.toContain('CONFIRMED_B');
  expect(
    observedAgents
      .get(child.childId)
      .session.snapshotEvents()
      .filter((e) => e.type === 'approval/policy'),
  ).toEqual(approval);
  await expect(
    Promise.resolve().then(() =>
      h.server.employeeDocuments.bind(child.childId, { user: '', memory: '' }),
    ),
  ).rejects.toThrow();
}, 30000);

it('real beginRun updates resident children and fork current PERSONA while native completed history stays intact, then missing/empty clears the reader', async () => {
  let runId = randomUUID();
  let entered = gate(),
    residentId,
    held = true;
  const h = await host({
    runId,
    model: async (request) => {
      if (
        request.sessionId !== 'pr0-root' &&
        (residentId === undefined || request.sessionId === residentId)
      ) {
        residentId = request.sessionId;
        entered.resolve();
        if (held) await hold(request.signal, gate());
      }
      return text('完成');
    },
    rootSystemInstructions: 'ROOT_STABLE',
    employeeDocuments: {
      persona: '# PERSONA.md\nRUN_A_PERSONA',
      user: '# USER.md\nRUN_A_USER',
      memory: '# MEMORY.md\nRUN_A_MEMORY',
    },
    bridge: async () => ({ allowed: true }),
  });
  await h.prompt('完成 A 根任务');
  await h.wait();
  const child = await h.spawn();
  await entered.promise;
  const resident = h.ctx.agents.get(child.childId);
  let settled = false;
  void child.result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const park = async () => {
    h.inject(resident, '待续本人任务');
    await h.ctx.subagents.interruptByParent(
      resident.id,
      h.root.id,
      'continuable',
    );
    await resident.whenIdle();
    await h.wait();
    expect(h.ctx.agents.get(child.childId)).toBe(resident);
    expect(resident.inbox.nextStep.length).toBeGreaterThan(0);
    expect(settled).toBe(false);
  };
  await park();
  const rootHistory = h.root.session.snapshotEvents();
  const childHistory = resident.session.snapshotEvents();
  const first = h.calls.find((r) => r.sessionId === child.childId);
  const begin = async (employeeDocuments) => {
    await h.server.handleRequest('run/end', { runId });
    runId = randomUUID();
    await h.server.handleRequest('run/begin', {
      sessionId: h.root.id,
      runId,
      employeeDocuments,
    });
  };
  const resume = async () => {
    entered = gate();
    await h.ctx.subagents.sendMessage(
      h.root,
      child.childId,
      text('继续本人任务'),
      {
        signal: new AbortController().signal,
      },
    );
    await entered.promise;
    expect(h.ctx.agents.get(child.childId)).toBe(resident);
    const request = h.calls.filter((r) => r.sessionId === child.childId).at(-1);
    await park();
    return request;
  };
  await begin({
    persona: '# PERSONA.md\nRUN_B_PERSONA {{missing}}',
    user: '# USER.md\nRUN_B_USER',
    memory: '# MEMORY.md\nRUN_B_MEMORY',
  });
  // Parent has no completed B turn: native fork seed still contains A.
  const forked = await h.spawn(h.root, '在 B 分叉', { provider: 'fork' });
  await forked.result;
  await h.wait();
  const forkRequest = h.calls.find((r) => r.sessionId === forked.childId);
  expect(JSON.stringify(forkRequest.messages)).toContain('RUN_A_USER');
  expect(JSON.stringify(forkRequest.messages)).toContain('RUN_A_MEMORY');
  expect(JSON.stringify(forkRequest.messages)).toContain('RUN_A_PERSONA');
  const forkCurrent = JSON.stringify(currentContext(forkRequest));
  expect(forkCurrent).toContain('RUN_B_PERSONA {{missing}}');
  for (const absent of [
    'RUN_A_PERSONA',
    'RUN_A_USER',
    'RUN_A_MEMORY',
    'RUN_B_USER',
    'RUN_B_MEMORY',
  ])
    expect(forkCurrent).not.toContain(absent);
  const updated = await resume();
  expect(JSON.stringify(currentContext(updated))).toContain(
    'RUN_B_PERSONA {{missing}}',
  );
  for (const absent of ['RUN_A_PERSONA', 'RUN_B_USER', 'RUN_B_MEMORY'])
    expect(JSON.stringify(currentContext(updated))).not.toContain(absent);
  expect(updated.tools).toEqual(first.tools);
  expect(updated.messages.filter((m) => m.role === 'system').at(-1)).toEqual(
    first.messages.filter((m) => m.role === 'system').at(-1),
  );
  for (const persona of [undefined, '']) {
    await begin({
      user: '# USER.md\nCURRENT_USER_ONLY',
      memory: '# MEMORY.md\nCURRENT_MEMORY_ONLY',
      ...(persona === undefined ? {} : { persona }),
    });
    const cleared = await resume();
    const current = JSON.stringify(currentContext(cleared));
    for (const absent of [
      'RUN_A_PERSONA',
      'RUN_B_PERSONA',
      'CURRENT_USER_ONLY',
      'CURRENT_MEMORY_ONLY',
    ])
      expect(current).not.toContain(absent);
  }
  for (const event of rootHistory)
    expect(h.root.session.snapshotEvents()).toContainEqual(event);
  for (const event of childHistory)
    expect(resident.session.snapshotEvents()).toContainEqual(event);
  held = false;
  await h.ctx.subagents.sendMessage(h.root, child.childId, text('最后完成'), {
    signal: new AbortController().signal,
  });
  await child.result;
  await h.wait();
  expect(h.ctx.agents.get(child.childId)).toBeUndefined();
}, 30000);

it('native cold child recreation reads the current Run PERSONA without replay or importing current USER/MEMORY', async () => {
  const runId = randomUUID();
  const observedAgents = new Map();
  const h = await host({
    runId,
    rootSystemInstructions: 'ROOT_STABLE',
    employeeDocuments: {
      persona: 'COLD_A_PERSONA',
      user: 'COLD_A_USER',
      memory: 'COLD_A_MEMORY',
    },
    bridge: async () => ({ allowed: true }),
  });
  h.ctx.on('agent/created', ({ agent }) => {
    observedAgents.set(agent.id, agent);
  });
  const child = await h.spawn();
  await child.result;
  await h.wait();
  expect(h.ctx.agents.get(child.childId)).toBeUndefined();
  const original = observedAgents.get(child.childId);
  const history = original.session.snapshotEvents();
  const count = h.calls.length;
  await h.server.closeRoot(h.root.id);
  await h.server.handleRequest('run/end', { runId });
  await h.server.handleRequest('session/recover', { sessionId: h.root.id });
  const root = h.server.requireRoot(h.root.id).agent;
  expect(root).not.toBe(h.root);
  expect(h.ctx.agents.get(child.childId)).toBeUndefined();
  expect(h.calls).toHaveLength(count);
  await h.server.handleRequest('run/begin', {
    sessionId: root.id,
    runId: randomUUID(),
    employeeDocuments: {
      persona: 'COLD_B_PERSONA {{missing}}',
      user: 'COLD_B_USER',
      memory: 'COLD_B_MEMORY',
    },
  });
  expect(h.calls).toHaveLength(count);
  await h.ctx.subagents.sendMessage(
    root,
    child.childId,
    text('恢复后继续本人任务'),
    {
      signal: new AbortController().signal,
    },
  );
  await h.wait();
  expect(h.ctx.agents.get(child.childId)).toBeUndefined();
  const recovered = observedAgents.get(child.childId);
  expect(recovered).toBeDefined();
  expect(recovered).not.toBe(original);
  for (const event of history)
    expect(recovered.session.snapshotEvents()).toContainEqual(event);
  const request = h.calls.filter((r) => r.sessionId === child.childId).at(-1);
  expect(JSON.stringify(currentContext(request))).toContain(
    'COLD_B_PERSONA {{missing}}',
  );
  for (const absent of ['COLD_A_PERSONA', 'COLD_B_USER', 'COLD_B_MEMORY'])
    expect(JSON.stringify(currentContext(request))).not.toContain(absent);
  expect(JSON.stringify(request.messages)).toContain('COLD_A_PERSONA');
}, 30000);

it('an independently selected native preset keeps its system persona ahead of employee PERSONA context', async () => {
  const observedAgents = new Map();
  const h = await host({
    runId: randomUUID(),
    rootSystemInstructions: 'ROOT_STABLE',
    employeeDocuments: {
      persona: 'EMPLOYEE_PERSONA {{missing}}',
      user: 'ROOT_ONLY_USER',
      memory: 'ROOT_ONLY_MEMORY',
    },
    bridge: async () => ({ allowed: true }),
  });
  h.ctx.on('agent/created', ({ agent }) => {
    observedAgents.set(agent.id, agent);
  });
  const plugin = join(h.directory, 'specialist-persona.mjs');
  await writeFile(
    plugin,
    `export const inject = ['systemPrompt'];
export function apply(ctx) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'deployment:persona-prefix',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: 'NATIVE_SPECIALIST_PERSONA',
  }));
}`,
  );
  await h.ctx.plugin(AgentPresets, { default: 'specialist' });
  await h.ctx.plugin({
    inject: ['agentPresets'],
    async *apply(ctx) {
      yield await ctx.agentPresets.register({
        id: 'specialist',
        plugins: [{ name: pathToFileURL(plugin).href }],
      });
    },
  });
  const child = await h.spawn(h.root, '使用原生专门预设', {
    request: {
      parent: h.root,
      prompt: text('专门子任务'),
      agentPreset: 'specialist',
    },
  });
  await child.result;
  await h.wait();
  const request = h.calls.find((r) => r.sessionId === child.childId);
  const system = JSON.stringify(
    request.messages.filter((m) => m.role === 'system').at(-1),
  );
  expect(system).toContain('NATIVE_SPECIALIST_PERSONA');
  expect(system).not.toContain('EMPLOYEE_PERSONA');
  expect(system).not.toContain('ROOT_STABLE');
  expect(JSON.stringify(currentContext(request))).toContain(
    'EMPLOYEE_PERSONA {{missing}}',
  );
  expect(JSON.stringify(request.messages)).not.toContain('ROOT_ONLY_USER');
  expect(JSON.stringify(request.messages)).not.toContain('ROOT_ONLY_MEMORY');
  expect(h.ctx.agents.get(child.childId)).toBeUndefined();
  expect(
    observedAgents.get(child.childId).session.snapshotEvents(),
  ).toContainEqual(
    expect.objectContaining({
      type: 'agent-preset/selected',
      data: { agentPreset: 'specialist' },
    }),
  );
}, 30000);

it('uses native context supersession for nonempty to empty without rewriting history', async () => {
  const runId = randomUUID();
  const h = await host({
    runId,
    rootSystemInstructions: 'ROOT_STABLE',
    employeeDocuments: {
      persona: '# PERSONA.md\nINITIAL_PERSONA',
      user: '',
      memory: '# MEMORY.md\nOLD_SNAPSHOT',
    },
    bridge: async () => ({ allowed: true }),
  });
  await h.prompt('第一轮');
  await h.wait();
  const old = h.root.session
    .snapshotEvents()
    .filter((e) => e.type === 'user/message');
  h.server.employeeDocuments.bind(h.root.id, {
    persona: '# PERSONA.md\nUPDATED_PERSONA',
    user: '',
    memory: '',
  });
  await h.prompt('第二轮');
  await h.wait();
  const events = h.root.session
    .snapshotEvents()
    .filter((e) => e.type === 'user/message');
  for (const event of old) expect(events).toContainEqual(event);
  const updates = events.filter(
    (e) => !old.some((prior) => prior.seq === e.seq),
  );
  expect(JSON.stringify(updates)).not.toContain('OLD_SNAPSHOT');
  expect(JSON.stringify(updates)).toContain('UPDATED_PERSONA');
  expect(JSON.stringify(updates)).not.toContain('INITIAL_PERSONA');
  // Other native runtime contexts may keep the full snapshot nonempty; the
  // updated snapshot, rather than a fabricated deletion, removes this section.
  expect(updates.length).toBeGreaterThan(1);
  h.server.employeeDocuments.bind(h.root.id, { user: '', memory: '' });
  await h.prompt('清空人设后的任务');
  await h.wait();
  const current = currentContext(h.calls.at(-1));
  expect(current).toBeDefined();
  expect(JSON.stringify(current)).not.toContain('UPDATED_PERSONA');
}, 30000);

it('cold root recovery keeps native history unchanged and the latest cleared snapshot current, without replay', async () => {
  const runId = randomUUID();
  const h = await host({
    runId,
    rootSystemInstructions: 'ROOT_STABLE',
    employeeDocuments: {
      persona: '# PERSONA.md\nOLD_PERSONA',
      user: '# USER.md\nOLD_ROLE',
      memory: '# MEMORY.md\nWITHDRAWN_MEMORY',
    },
    bridge: async (method) => {
      if (method === 'allrice/run-authorize') return { allowed: true };
      throw Error(`Unexpected tool replay: ${method}`);
    },
  });
  await h.prompt('第一轮');
  await h.wait();
  await h.server.handleRequest('run/end', { runId });
  const nextRun = randomUUID();
  const empty = { user: '', memory: '' };
  await h.server.handleRequest('run/begin', {
    sessionId: h.root.id,
    runId: nextRun,
    employeeDocuments: empty,
  });
  await h.server.handleRequest('session/prompt', {
    sessionId: h.root.id,
    runId: nextRun,
    contentBlocks: text('撤回后的新任务'),
  });
  await h.wait();
  const before = h.root.session
    .snapshotEvents()
    .filter((e) => e.type === 'user/message');
  expect(JSON.stringify(before)).toContain('WITHDRAWN_MEMORY');
  expect(JSON.stringify(before)).toContain('OLD_PERSONA');
  const count = h.calls.length;
  await h.server.closeRoot(h.root.id);
  await h.server.handleRequest('run/end', { runId: nextRun });
  await h.server.handleRequest('session/recover', { sessionId: h.root.id });
  expect(h.calls.length).toBe(count);
  const recovered = h.server.requireRoot(h.root.id).agent;
  expect(recovered).not.toBe(h.root);
  await h.server.handleRequest('run/begin', {
    sessionId: h.root.id,
    runId: nextRun,
    employeeDocuments: empty,
  });
  expect(h.calls.length).toBe(count);
  await h.server.handleRequest('session/prompt', {
    sessionId: h.root.id,
    runId: nextRun,
    contentBlocks: text('恢复后继续'),
  });
  await h.wait();
  expect(h.calls.length).toBe(count + 1);
  const after = recovered.session
    .snapshotEvents()
    .filter((e) => e.type === 'user/message');
  for (const event of before) expect(after).toContainEqual(event);
  const request = h.calls.at(-1);
  expect(runtimeContexts(request).length).toBeGreaterThan(1);
  const current = currentContext(request);
  expect(current).toBeDefined();
  expect(JSON.stringify(current)).not.toContain('WITHDRAWN_MEMORY');
  expect(JSON.stringify(current)).not.toContain('OLD_ROLE');
  expect(JSON.stringify(current)).not.toContain('OLD_PERSONA');
  expect(JSON.stringify(request.messages)).toContain('WITHDRAWN_MEMORY');
  expect(JSON.stringify(request.messages)).toContain('OLD_PERSONA');
}, 30000);
