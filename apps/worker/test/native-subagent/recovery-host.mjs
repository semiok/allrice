/* global process, AbortController */
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createAllRiceRuntime } from '../../dsh/allrice-jsonrpc-implementation.mjs';

const [mode, directory, childId] = process.argv.slice(2);
Object.assign(process.env, {
  DSH_HOME: directory,
  DSH_CWD: directory,
  DSH_SESSION_ROOT: join(directory, 'sessions'),
  DSH_CREDENTIALS_PATH: join(directory, 'credentials.yml'),
  DSH_CORDIS_CONFIG: join(directory, 'profile.yml'),
});
let ctx, server;
try {
  ({ ctx, server } = await createAllRiceRuntime(
    {
      notify() {},
      request() {
        throw Error('unexpected bridge');
      },
    },
    {
      runtimeName: 'pr0-recovery',
      installedDshRuntimeVersion: '0.2.1-rc.2',
      assertInitializationOpen() {},
      ownContext() {},
      ownServer() {},
    },
  ));
  const requests = [];
  let entered;
  const childStarted = new Promise((done) => {
    entered = done;
  });
  class Synthetic extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    }
    async *stream(request) {
      requests.push(request.sessionId);
      if (mode === 'start') {
        entered();
        await new Promise((_, reject) =>
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          ),
        );
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '恢复后回复' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '恢复后回复' },
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['pr0'], new Synthetic());
  await server.handleRequest('initialize', {
    cwd: directory,
    provider: 'pr0',
    model: 'fixed',
    nativeTools: [],
    nativeSkills: [],
    contentScenes: [],
    requireContentGuard: false,
    requireTaskProgress: false,
  });
  const root = (await server.ensureRoot('recovery-root')).agent;
  if (mode === 'start') {
    const activation = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: 'crash child',
      delivery: 'parent',
      signal: new AbortController().signal,
      request: {
        parent: root,
        prompt: [{ type: 'text', text: '崩溃前的子任务' }],
      },
    });
    await childStarted;
    await ctx.sessions.flush(root.session);
    await ctx.sessions.flush(ctx.agents.get(activation.childId).session);
    process.send({ childId: activation.childId });
    await new Promise(() => {}); // Intentionally killed by the test; no cleanup/replay.
  } else {
    const before = {
      requests: requests.length,
      descendants: await ctx.subagents.listDescendants(root.id),
    };
    await ctx.subagents.sendMessage(
      root,
      childId,
      [{ type: 'text', text: '请继续刚才的子任务' }],
      { signal: new AbortController().signal },
    );
    await server.waitRoot(root.id);
    const observation = await ctx.sessionQuery.observeSession(childId);
    const turns = observation.events
      .filter((event) => event.type === 'turn/end')
      .map((event) => event.data.reason.kind);
    observation[Symbol.dispose]();
    process.send({
      before,
      turns,
      requests,
      notices: root.session
        .snapshotEvents()
        .filter(
          (event) =>
            event.type === 'user/message' &&
            event.data.source?.kind === 'subagent-settled',
        ).length,
    });
  }
} catch (error) {
  process.send({ error: { name: error.name, message: error.message } });
} finally {
  if (ctx) await ctx.subagents.drainDescendants(ctx.agents.roots());
  if (server) await server.shutdown();
  if (ctx) await ctx.fiber.dispose();
  process.disconnect();
}
