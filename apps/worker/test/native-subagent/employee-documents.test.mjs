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
