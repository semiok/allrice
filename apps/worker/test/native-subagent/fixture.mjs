/* global process, AbortController */
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, vi } from 'vitest';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createAllRiceRuntime } from '../../dsh/allrice-jsonrpc-implementation.mjs';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../src/harness/dsh-distribution.ts';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
export const text = (value) => [{ type: 'text', text: value }];
export function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function hold(signal, barrier) {
  signal.throwIfAborted();
  let abort;
  try {
    await Promise.race([
      barrier.promise,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Actual production host and JSONL persistence; only the LLM transport is a
 * synthetic adapter. Its responses use the same content blocks as p24. */
export async function host({
  model = async () => text('完成'),
  // An explicit production profile is loaded unchanged, without the test-only
  // query/delegation composition; only the synthetic LLM adapter is replaced.
  productionProfile,
  depth = 1,
  rootId = 'pr0-root',
  accounting = false,
  provider = 'pr0-synthetic',
  modelName = 'fixed',
  usage = { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
  stream,
  active = 8,
  runId,
  prepare = async () => {},
  bridge = async (method) => {
    throw Error(`unexpected bridge ${method}`);
  },
} = {}) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-pr0-')),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await symlink(
    resolve(import.meta.dirname, '../../node_modules'),
    join(directory, 'node_modules'),
  );
  const profile = await readFile(
    resolve(
      import.meta.dirname,
      `../../dsh/${productionProfile ?? 'allrice-restricted'}.cordis.yml`,
    ),
    'utf8',
  );
  const plugins = productionProfile
    ? ''
    : '\n' +
      (await readFile(
        resolve(import.meta.dirname, 'plugins.cordis.yml'),
        'utf8',
      ));
  await writeFile(join(directory, 'profile.yml'), profile + plugins);
  await writeFile(
    join(directory, 'credentials.yml'),
    '{"version":1,"records":{}}',
    { mode: 0o600 },
  );
  for (const [key, value] of Object.entries({
    DSH_CORDIS_CONFIG: join(directory, 'profile.yml'),
    DSH_HOME: directory,
    DSH_SESSION_ROOT: join(directory, 'sessions'),
    DSH_CWD: directory,
    DSH_CREDENTIALS_PATH: join(directory, 'credentials.yml'),
    PR0_MAX_DEPTH: String(depth),
    PR0_MAX_ACTIVE: String(active),
    ALLRICE_ASK_USER_MODE: 'timed',
    ALLRICE_ASK_USER_TIMEOUT: undefined,
    ALLRICE_ASSISTANTS_ENABLED: undefined,
    ALLRICE_PROGRESS_GUARD_ENABLED: undefined,
    DSH_RUNTIME_HOME: undefined,
  }))
    vi.stubEnv(key, value);
  const previous = new Map(
    ['uncaughtException', 'unhandledRejection'].map((name) => [
      name,
      process.listeners(name),
    ]),
  );
  cleanups.push(() => {
    for (const [name, listeners] of previous)
      for (const listener of process.listeners(name))
        if (!listeners.includes(listener))
          process.removeListener(name, listener);
  });
  const notices = [],
    calls = [];
  await prepare(directory);
  const { ctx, server } = await createAllRiceRuntime(
    {
      notify: (method, params) => notices.push({ method, params }),
      request: bridge,
    },
    {
      runtimeName: 'pr0-test',
      installedDshRuntimeVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      assertInitializationOpen() {},
      ownContext() {},
      ownServer() {},
    },
  );
  cleanups.push(async () => {
    await ctx.subagents.drainDescendants(ctx.agents.roots());
    await server.shutdown();
    await ctx.fiber.dispose();
  });
  class Synthetic extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    }
    async *stream(request) {
      calls.push(request);
      if (stream) {
        yield* stream(request, calls.length);
        return;
      }
      const blocks = await model(request, calls.length);
      for (const [index, block] of blocks.entries()) {
        yield { type: 'block-start', index, blockType: block.type };
        if (block.type === 'text')
          yield { type: 'text-delta', index, text: block.text };
        yield { type: 'block-end', index, block };
      }
      yield {
        type: 'usage',
        usage,
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
  ctx.llm.registerAdapter([provider], new Synthetic());
  await server.handleRequest('initialize', {
    cwd: directory,
    provider,
    model: modelName,
    requireNativeAccounting: accounting,
    nativeTools: [],
    nativeSkills: [],
    contentScenes: [],
    requireContentGuard: false,
    requireTaskProgress: false,
    requireRunAdmission: !!runId,
  });
  const root = (await server.ensureRoot(rootId)).agent;
  if (runId)
    await server.handleRequest('run/begin', { sessionId: rootId, runId });
  const spawn = (parent = root, prompt = '子任务', options = {}) =>
    ctx.subagents.startActivation({
      provider: 'spawn',
      label: prompt,
      request: { parent, prompt: text(prompt) },
      signal: new AbortController().signal,
      delivery: 'parent',
      ...options,
    });
  return {
    ctx,
    server,
    root,
    calls,
    notices,
    directory,
    spawn,
    prompt: (value) =>
      server.handleRequest('session/prompt', {
        sessionId: root.id,
        runId,
        contentBlocks: text(value),
      }),
    wait: () => server.handleRequest('session/wait', { sessionId: root.id }),
    inject: (agent, value) =>
      agent.inject(
        createUserMessage({ content: text(value), source: { kind: 'user' } }),
      ),
  };
}
