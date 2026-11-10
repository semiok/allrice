import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { host, text } from './fixture.mjs';

it.each([false, true])(
  'actual root/child/fork/cold-resume preserves frozen web visibility and caller identity (selected=%s)',
  async (selected) => {
    const runId = randomUUID(),
      calls = [],
      steps = new Map();
    const h = await host({
      runId,
      nativeTools: selected ? ['web.search', 'web.fetch'] : [],
      bridge: async (method, params) => {
        if (method === 'allrice/run-authorize') return { allowed: true };
        expect(method).toBe('allrice/tool-call');
        calls.push(params);
        return {
          modelContent: JSON.stringify({
            url: 'https://source.test',
            statusCode: 200,
            body: { kind: 'text', content: 'offline source' },
            truncated: false,
          }),
          summary: 'fixture',
        };
      },
      model: async (request) => {
        const step = (steps.get(request.sessionId) ?? 0) + 1;
        steps.set(request.sessionId, step);
        if (selected && step === 1)
          return [
            {
              type: 'tool-call',
              id: `read-${request.sessionId}`,
              name: 'web_fetch',
              arguments: JSON.stringify({ url: 'https://source.test' }),
            },
          ];
        return text('完成');
      },
    });
    await h.prompt('读取公开资料');
    await h.wait();
    const child = await h.spawn();
    await child.result;
    await h.wait();
    const fork = await h.spawn(h.root, '继承资料研究', { provider: 'fork' });
    await fork.result;
    await h.wait();
    const names = (request) =>
      request.tools
        .map((t) => t.name)
        .filter((n) => n.startsWith('web_'))
        .sort();
    const expected = selected ? ['web_fetch', 'web_search'] : [];
    for (const id of [h.root.id, child.childId, fork.childId]) {
      expect(
        names(h.calls.find((request) => request.sessionId === id)),
      ).toEqual(expected);
      const toolCall = calls.find((call) => call.nativeSessionId === id);
      if (selected)
        expect(toolCall).toMatchObject({
          runId,
          rootSessionId: h.root.id,
          nativeSessionId: id,
          parentSessionId: id === h.root.id ? null : h.root.id,
          delegationDepth: id === h.root.id ? 0 : 1,
        });
      else expect(toolCall).toBeUndefined();
    }
    const history = h.root.session
      .snapshotEvents()
      .filter((e) => e.type === 'user/message');
    await h.server.handleRequest('run/end', { runId });
    await h.server.closeRoot(h.root.id);
    await h.server.handleRequest('session/recover', { sessionId: h.root.id });
    await h.server.handleRequest('run/begin', { sessionId: h.root.id, runId });
    steps.set(h.root.id, 0);
    const count = calls.length;
    await h.prompt('恢复后再读');
    await h.wait();
    expect(
      names(
        h.calls.filter((request) => request.sessionId === h.root.id).at(-1),
      ),
    ).toEqual(expected);
    if (selected)
      expect(calls.slice(count)).toContainEqual(
        expect.objectContaining({
          runId,
          nativeSessionId: h.root.id,
          parentSessionId: null,
        }),
      );
    for (const event of history)
      expect(
        h.server.requireRoot(h.root.id).agent.session.snapshotEvents(),
      ).toContainEqual(event);
  },
  30000,
);
