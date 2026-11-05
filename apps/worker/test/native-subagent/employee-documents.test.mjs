/* global AbortController */
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { host, text } from './fixture.mjs';

it('only the admitted root gets required literal documents; child current prompt/tools/approval stay unchanged and fork inherits completed history', async () => {
  const runId = randomUUID();
  const observedAgents = new Map();
  const h = await host({
    model: async (request) => {
      observedAgents.set(
        request.sessionId,
        h.ctx.agents.get(request.sessionId),
      );
      return text('完成');
    },
    runId,
    rootSystemInstructions: 'ROOT_STABLE_PERSONA',
    employeeDocuments: {
      user: '# USER.md\nPERSON {{missing}}',
      memory: '# MEMORY.md\nCONFIRMED_A',
    },
    prepare: async () =>
      vi.stubEnv('DSH_SYSTEM_PROMPT', 'LEGACY_CHILD_PERSONA'),
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
  const child = await h.spawn();
  await child.result;
  await h.wait();
  const childRequest = h.calls.find((r) => r.sessionId === child.childId);
  expect(JSON.stringify(childRequest.messages)).toContain(
    'LEGACY_CHILD_PERSONA',
  );
  expect(JSON.stringify(childRequest.messages)).not.toContain('CONFIRMED_A');
  const childAgent = observedAgents.get(child.childId);
  const approval = childAgent.session
    .snapshotEvents()
    .filter((e) => e.type === 'approval/policy');
  expect(approval.map((e) => e.data.policy)).toContain('never');
  const forked = await h.spawn(h.root, '原生分叉', { provider: 'fork' });
  await forked.result;
  await h.wait();
  const forkRequest = h.calls.find((r) => r.sessionId === forked.childId);
  expect(JSON.stringify(forkRequest.messages)).toContain('CONFIRMED_A');
  expect(
    JSON.stringify(
      forkRequest.messages.filter((m) => m.role === 'system').at(-1),
    ),
  ).toContain('LEGACY_CHILD_PERSONA');
  // The same child continues with its own unchanged current system/tools.
  h.server.employeeDocuments.bind(h.root.id, {
    user: '',
    memory: '# MEMORY.md\nCONFIRMED_B',
  });
  await h.ctx.subagents.sendMessage(h.root, child.childId, text('继续'), {
    signal: new AbortController().signal,
  });
  await h.wait();
  const last = h.calls.filter((r) => r.sessionId === child.childId).at(-1);
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

it('uses native context supersession for nonempty to empty without rewriting history', async () => {
  const runId = randomUUID();
  const h = await host({
    runId,
    rootSystemInstructions: 'ROOT_STABLE',
    employeeDocuments: { user: '', memory: '# MEMORY.md\nOLD_SNAPSHOT' },
    bridge: async () => ({ allowed: true }),
  });
  await h.prompt('第一轮');
  await h.wait();
  const old = h.root.session
    .snapshotEvents()
    .filter((e) => e.type === 'user/message');
  h.server.employeeDocuments.bind(h.root.id, { user: '', memory: '' });
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
  // Other native runtime contexts may keep the full snapshot nonempty; the
  // updated snapshot, rather than a fabricated deletion, removes this section.
  expect(updates.length).toBeGreaterThan(1);
}, 30000);

it('cold root recovery keeps native history unchanged and the latest cleared snapshot current, without replay', async () => {
  const runId = randomUUID();
  const h = await host({
    runId,
    rootSystemInstructions: 'ROOT_STABLE',
    employeeDocuments: {
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
  const contexts = request.messages.filter((message) =>
    JSON.stringify(message.content).includes(
      'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    ),
  );
  expect(contexts.length).toBeGreaterThan(1);
  expect(JSON.stringify(contexts.at(-1))).not.toContain('WITHDRAWN_MEMORY');
  expect(JSON.stringify(contexts.at(-1))).not.toContain('OLD_ROLE');
  expect(JSON.stringify(request.messages)).toContain('WITHDRAWN_MEMORY');
}, 30000);
