import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { gate, host, text } from './fixture.mjs';

it.each([false, true])(
  'actual registration: ordinary root selected=%s; child/fork unchanged, resume restored',
  async (selected) => {
    const runId = randomUUID();
    const h = await host({
      runId,
      nativeTools: selected ? ['workspace.file.read'] : [],
      bridge: async (method) => {
        if (method === 'allrice/run-authorize') return { allowed: true };
        throw Error(`unexpected bridge ${method}`);
      },
    });
    await h.prompt('核对本轮资料');
    await h.wait();
    const root = h.calls.find((r) => r.sessionId === h.root.id);
    const child = await h.spawn();
    await child.result;
    await h.wait();
    const fork = await h.spawn(h.root, '原生继承', { provider: 'fork' });
    await fork.result;
    await h.wait();
    const names = (r) => r.tools.map((t) => t.name).sort();
    const childRequest = h.calls.find((r) => r.sessionId === child.childId);
    const forkRequest = h.calls.find((r) => r.sessionId === fork.childId);
    expect(names(root).includes('workspace_file_read')).toBe(selected);
    expect(names(childRequest)).toEqual(
      names(root).filter((n) => n !== 'workspace_file_read'),
    );
    expect(names(forkRequest)).toEqual(names(childRequest));
    const history = h.root.session
      .snapshotEvents()
      .filter((e) => e.type === 'user/message');
    await h.server.handleRequest('run/end', { runId });
    await h.server.closeRoot(h.root.id);
    await h.server.handleRequest('session/recover', { sessionId: h.root.id });
    await h.server.handleRequest('run/begin', { sessionId: h.root.id, runId });
    await h.prompt('恢复后继续');
    await h.wait();
    expect(
      names(h.calls.filter((r) => r.sessionId === h.root.id).at(-1)),
    ).toEqual(names(root));
    for (const event of history)
      expect(
        h.server.requireRoot(h.root.id).agent.session.snapshotEvents(),
      ).toContainEqual(event);
    console.log(
      'FILE_READ_PRODUCT_DECLARATIONS',
      JSON.stringify({
        selected,
        root: names(root),
        child: names(childRequest),
        fork: names(forkRequest),
        resume: names(h.calls.at(-1)),
      }),
    );
  },
  30000,
);

it.each(['success', 'denied'])(
  'a native file timeout remains terminal even when the Broker later returns %s',
  async (outcome) => {
    const dispatched = gate(), release = gate(), aborted = gate();
    const h = await host({
      nativeTools: ['workspace.file.read'],
      model: async (_request, count) => {
        if (count !== 1) return text('must not continue after cancellation');
        h.ctx.tools.get('workspace_file_read', h.root).timeoutMs = 100;
        return [{
        type: 'tool-call', id: 'timed-read', name: 'workspace_file_read',
        arguments: JSON.stringify({objectId: randomUUID()}),
        }];
      },
      bridge: async (method, params) => {
        expect(method).toBe('allrice/tool-call');
        dispatched.resolve();
        await release.promise;
        return outcome === 'success'
          ? {modelContent: 'late contents', summary: 'late read'}
          : {modelContent: '', summary: 'denied', fileReadDenied: {
            callId: params.toolCallId, nativeSessionId: params.nativeSessionId,
            code: 'TOOL_FILE_ACCESS_DENIED',
          }};
      },
    });
    // Only scale the public declaration's budget; production execution and
    // DSH timeout policy remain unchanged, and the in-flight read is joined.
    h.ctx.on('tools/execute', (exec, next) => {
      if (exec.name === 'workspace_file_read')
        exec.signal.addEventListener('abort', () => aborted.resolve(), {once: true});
      return next();
    });
    try {
      await h.prompt('读取我之前保存的资料入口并完成核对。');
      await dispatched.promise;
      await aborted.promise;
      release.resolve();
      await h.wait();
      expect(h.calls).toHaveLength(1);
      expect(h.root.session.snapshotEvents().findLast(e => e.type === 'turn/end').data.reason)
        .toEqual({kind: 'aborted', reason: {kind: 'hook', reason: 'ALLRICE_FILE_READ_ABORTED'}});
    } finally {
      release.resolve();
    }
  }, 10000,
);
