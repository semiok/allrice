/* global process */
// Same scripted conversation, two hosts. Native packages resolve exclusively
// from the supplied isolated, same-generation installation; Worker resolves its
// own graph. No reference bundle is added to the production dependency closure.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  readFile,
  writeFile,
  mkdtemp,
  realpath,
  symlink,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mode = process.argv[2];
assert(['native', 'worker'].includes(mode));
const worker = resolve(import.meta.dirname, '../..');
const modules =
  mode === 'native' ? resolve(process.argv[3]) : join(worker, 'node_modules');
const requirePackage = createRequire(join(modules, '../pr0-anchor.cjs'));
const load = (name) => import(pathToFileURL(requirePackage.resolve(name)).href);
const version = JSON.parse(
  await readFile(
    requirePackage.resolve('@deepseek-ai/dsh-subagent/package.json'),
    'utf8',
  ),
).version;
assert.equal(version, '0.2.1-rc.2');
const directory = await realpath(
  await mkdtemp(join(tmpdir(), 'pr0-baseline-')),
);
for (const [key, value] of Object.entries({
  DSH_HOME: directory,
  DSH_CWD: directory,
  DSH_SESSION_ROOT: join(directory, 'sessions'),
  DSH_CREDENTIALS_PATH: join(directory, 'credentials.yml'),
}))
  process.env[key] = value;
await writeFile(
  process.env.DSH_CREDENTIALS_PATH,
  '{"version":1,"records":{}}',
  { mode: 0o600 },
);
await symlink(modules, join(directory, 'node_modules'));
const profile = join(directory, 'profile.yml');
const { boot, loadOverlayPatches } = await load('@deepseek-ai/dsh-app-boot');
let ctx, server;
try {
  if (mode === 'native') {
    await writeFile(profile, '[]\n');
    const patches = [
      '@deepseek-ai/dsh-base/cordis.patch.yml',
      '@deepseek-ai/dsh-web-app/cordis.patch.yml',
      '@deepseek-ai/dsh-web-app/presets/standard.patch.yml',
    ].flatMap((name) =>
      loadOverlayPatches('pr0', requirePackage.resolve(name)),
    );
    patches.push(
      // The SDK is this offline test's transport. Browser sockets are unused.
      ...['webserver', 'web-runtime', 'connection', 'web-startup'].map(
        (id) => ({ id, disabled: true }),
      ),
      { id: 'session-title-llm', disabled: true },
      {
        id: 'credentials',
        config: { path: process.env.DSH_CREDENTIALS_PATH, watch: false },
      },
      {
        id: 'session-persistence-jsonl',
        config: { root: process.env.DSH_SESSION_ROOT, compression: 'none' },
      },
      {
        id: 'agent-default-model',
        config: { provider: 'pr0', model: 'synthetic' },
      },
      { id: 'agent-loop', config: { agents: [] } },
    );
    // pnpm's reference tree can put direct peers outside its flattened links.
    // Resolve every plugin from the same installed anchor before loading.
    function resolvePlugins(value) {
      if (!value || typeof value !== 'object') return;
      if (
        typeof value.name === 'string' &&
        value.name.startsWith('@deepseek-ai/')
      )
        value.name = pathToFileURL(requirePackage.resolve(value.name)).href;
      for (const child of Object.values(value)) resolvePlugins(child);
    }
    resolvePlugins(patches);
    ctx = await boot('pr0-native-standard', profile, patches);
    const { HarnessSdkJsonRpcServer } = await load(
      '@deepseek-ai/dsh-sdk-jsonrpc-server',
    );
    server = new HarnessSdkJsonRpcServer(ctx, {
      notify() {},
      request() {
        throw Error('unexpected external request');
      },
    });
  } else {
    await writeFile(
      profile,
      (await readFile(
        join(worker, 'dsh/allrice-restricted.cordis.yml'),
        'utf8',
      )) +
        '\n' +
        (await readFile(
          join(import.meta.dirname, 'plugins.cordis.yml'),
          'utf8',
        )),
    );
    process.env.DSH_CORDIS_CONFIG = profile;
    const { createAllRiceRuntime } =
      await import('../../dsh/allrice-jsonrpc-implementation.mjs');
    ({ ctx, server } = await createAllRiceRuntime(
      {
        notify() {},
        request() {
          throw Error('unexpected external request');
        },
      },
      {
        runtimeName: 'pr0-worker',
        installedDshRuntimeVersion: version,
        assertInitializationOpen() {},
        ownContext() {},
        ownServer() {},
      },
    ));
  }
  const { LlmAdapter } = await load('@deepseek-ai/dsh-llm');
  const steps = new Map(),
    requests = [],
    chronology = [];
  let releaseChildren;
  const childrenGate = new Promise((done) => {
    releaseChildren = done;
  });
  const rootId = 'baseline-root';
  const content = (text) => [{ type: 'text', text }];
  const tool = (id, name, args) => ({
    type: 'tool-call',
    id,
    name,
    arguments: JSON.stringify(args),
  });
  class Synthetic extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    }
    async *stream(request) {
      requests.push(request);
      const step = (steps.get(request.sessionId) ?? 0) + 1;
      steps.set(request.sessionId, step);
      let blocks;
      if (request.sessionId === rootId) {
        if (step === 1)
          blocks = Array.from({ length: 9 }, (_, i) =>
            tool(`spawn-${i}`, 'subagent', {
              description: `task-${i}`,
              prompt: `报告任务 ${i}`,
            }),
          );
        else if (step === 2) blocks = [tool('list-running', 'list_agents', {})];
        else {
          releaseChildren();
          blocks = content('主级收到结果');
        }
      } else {
        await childrenGate;
        if (step === 1)
          blocks = [
            tool(`reply-${request.sessionId}`, 'send_message', {
              agent_id: rootId,
              message: '子级进度',
            }),
            tool(`depth-${request.sessionId}`, 'subagent', {
              description: 'grandchild',
              prompt: '继续委派',
            }),
          ];
        else blocks = content('子级最后回复');
      }
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type };
        if (block.type === 'text')
          yield { type: 'text-delta', index, text: block.text };
        yield { type: 'block-end', index, block };
      }
      yield {
        type: 'usage',
        usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
      };
      yield {
        type: 'finish',
        reason: {
          kind: blocks.some((b) => b.type === 'tool-call')
            ? 'tool-calls'
            : 'stop',
        },
      };
    }
  }
  ctx.llm.registerAdapter(['pr0'], new Synthetic());
  const initialize = {
    cwd: directory,
    provider: 'pr0',
    model: 'synthetic',
    nativeTools: [],
    nativeSkills: [],
    contentScenes: [],
    requireContentGuard: false,
    requireTaskProgress: false,
  };
  if (mode === 'worker') await server.handleRequest('initialize', initialize);
  else await server.initialize(initialize);
  if (mode === 'worker') await server.ensureRoot(rootId);
  else {
    await server.getWorkingDirectory({ sessionId: rootId });
    await ctx.agentPresets.select(ctx.agents.get(rootId), 'standard');
  }
  ctx.on('subagent/end', (info) => {
    chronology.push(`settled:${info.id}`);
  });
  const prompt = {
    sessionId: rootId,
    contentBlocks: content(
      '请同时派九个子智能体，各自报告结果，有困难告诉我。',
    ),
  };
  if (mode === 'worker') await server.handleRequest('session/prompt', prompt);
  else await server.prompt(prompt);
  if (mode === 'worker')
    await server.handleRequest('session/wait', { sessionId: rootId });
  else await server.wait({ sessionId: rootId });
  chronology.push('wait-returned');
  const root = ctx.agents.get(rootId);
  const events = root.session.snapshotEvents();
  const catalog = events.filter((e) => e.type === 'subagent/catalog');
  const names = new Map(catalog.map((e) => [e.data.childId, e.data.label]));
  const rows = await ctx.subagents.listDescendants(rootId);
  const normalize = (value) => {
    let result = JSON.stringify(value);
    for (const [id, label] of names) result = result.replaceAll(id, label);
    return result;
  };
  const modelText = requests.map((r) => normalize(r.messages));
  const capacity =
    'subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents';
  const depth = 'subagent depth 2 exceeds maxDepth 1';
  assert(modelText.some((s) => s.includes(capacity)));
  assert(modelText.some((s) => s.includes(depth)));
  assert.equal(catalog.length, 8);
  assert.equal(rows.length, 8);
  assert(rows.every((row) => row.activity === 'inactive'));
  assert.equal(chronology.filter((s) => s.startsWith('settled:')).length, 8);
  const perChild = [...names]
    .map(([id, label]) => ({
      label,
      events: events.flatMap((event) => {
        if (event.type === 'subagent/catalog' && event.data.childId === id)
          return ['catalog'];
        if (
          event.type === 'user/message' &&
          event.data.source?.senderSessionId === id
        )
          return [event.data.source.kind];
        return [];
      }),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const child of perChild)
    assert.deepEqual(child.events, [
      'catalog',
      'agent-message',
      'subagent-settled',
    ]);
  const runningList = requests
    .filter((r) => r.sessionId === rootId)
    .some((r) => JSON.stringify(r.messages).includes('running'));
  assert(runningList);
  process.stdout.write(
    JSON.stringify({
      version,
      perChild,
      capacity,
      depth,
      runningList,
      inactive: rows.length,
      waitAfterAllSettlements: chronology.at(-1) === 'wait-returned',
    }) + '\n',
  );
} finally {
  if (ctx) await ctx.subagents.drainDescendants(ctx.agents.roots());
  if (server) await server.shutdown();
  if (ctx) await ctx.fiber.dispose();
  await rm(directory, { recursive: true, force: true });
}
