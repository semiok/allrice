import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { host } from './fixture.mjs';

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
