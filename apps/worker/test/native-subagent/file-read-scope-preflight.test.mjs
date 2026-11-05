/* global AbortController */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { host, text } from './fixture.mjs';

// Test-only scope experiment. No product registration or real model is changed.
// The selected capability's public schema is intentionally inert: this checks
// declarations, lifecycle and inheritance before authorizing an implementation.
const wire = 'workspace_file_read';
const definition = defineTool({
  name: wire,
  description: 'Scope preflight: read an authorized workspace file.',
  parameters: {
    objectId: { type: 'string', required: true },
    offset: { type: 'integer' },
    limit: { type: 'integer' },
  },
  output: {
    schema: { type: 'object', properties: { content: { type: 'string', required: true } }, additionalProperties: false },
    render: (_args, value) => text(value.content),
  },
  execute: () => { throw Error('PREFLIGHT_MUST_NOT_EXECUTE_FILES'); },
});
const names = (r) => r.tools.map((t) => t.name).sort();

it.each(['baseline', 'global', 'root-local'])(
  'public DSH declaration differential: %s root/child/fork/resume',
  async (mode) => {
    const runId = randomUUID();
    const agents = new Map();
    const h = await host({
      runId,
      model: async (request) => {
        agents.set(request.sessionId, h.ctx.agents.get(request.sessionId));
        return text('合成声明核对完成');
      },
      bridge: async (method) => {
        if (method === 'allrice/run-authorize') return { allowed: true };
        throw Error(`unexpected bridge ${method}`);
      },
    });
    if (mode === 'global') h.ctx.tools.register(definition);
    if (mode === 'root-local') {
      h.root.ctx.tools.register(definition);
      // Public creation event restores local registration, without child
      // lifecycle changes or editing persisted history.
      h.ctx.on('agent/created', ({ agent }) => {
        if (agent.id === h.root.id) agent.ctx.tools.register(definition);
      });
    }
    await h.prompt('完成根任务并保留公开历史');
    await h.wait();
    const root = h.calls.find((r) => r.sessionId === h.root.id);
    const child = await h.spawn();
    await child.result;
    await h.wait();
    const fork = await h.spawn(h.root, '原生分叉', { provider: 'fork' });
    await fork.result;
    await h.wait();
    const childRequest = h.calls.find((r) => r.sessionId === child.childId);
    const forkRequest = h.calls.find((r) => r.sessionId === fork.childId);
    const approval = (id) => agents.get(id).session.snapshotEvents()
      .filter((e) => e.type === 'approval/policy').map((e) => e.data.policy);
    const priorHistory = h.root.session.snapshotEvents()
      .filter((e) => e.type === 'user/message');
    await h.server.handleRequest('run/end', { runId });
    await h.server.closeRoot(h.root.id);
    await h.server.handleRequest('session/recover', { sessionId: h.root.id });
    const recovered = h.server.requireRoot(h.root.id).agent;
    expect(recovered).not.toBe(h.root);
    await h.server.handleRequest('run/begin', { sessionId: h.root.id, runId });
    await h.prompt('恢复后继续核对声明');
    await h.wait();
    const resumed = h.calls.filter((r) => r.sessionId === h.root.id).at(-1);
    for (const event of priorHistory)
      expect(recovered.session.snapshotEvents()).toContainEqual(event);
    const observed = {
      mode,
      root: names(root),
      child: names(childRequest),
      fork: names(forkRequest),
      resume: names(resumed),
      childApproval: approval(child.childId),
      forkApproval: approval(fork.childId),
      forkInheritedRootPrompt: JSON.stringify(forkRequest.messages)
        .includes('完成根任务并保留公开历史'),
    };
    console.log('FILE_READ_SCOPE_PREFLIGHT', JSON.stringify(observed));
    expect(names(root).includes(wire)).toBe(mode !== 'baseline');
    expect(names(resumed)).toEqual(names(root));
    expect(names(childRequest).includes(wire)).toBe(mode === 'global');
    expect(names(forkRequest).includes(wire)).toBe(mode === 'global');
    expect(names(childRequest)).toEqual(names(forkRequest));
    expect(observed.childApproval).toContain('never');
    expect(observed.forkApproval).toContain('never');
    expect(observed.forkInheritedRootPrompt).toBe(true);
  },
  30000,
);
