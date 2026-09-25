import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HarnessExecutionInput } from '../adapter.js';
import { DshRuntimePool } from './runtime-pool.js';

let root: string;
const pools: DshRuntimePool[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allrice-runtime-reuse-'));
  vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(root, 'platform'));
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function pool(native = false) {
  const instance = new DshRuntimePool({
    runtimeRoot: join(root, 'runtime'),
    runtimeCommand: process.execPath,
    runtimeArgs: [
      resolve(
        import.meta.dirname,
        native
          ? '../../../dsh/allrice-jsonrpc-runtime.mjs'
          : '../fixtures/dsh-fake-runtime.mjs',
      ),
    ],
    credentialResolver: { resolve: async () => ({ apiKey: 'synthetic-only' }) },
    requestTimeoutMs: 15_000,
  });
  pools.push(instance);
  return instance;
}

function request(): Parameters<DshRuntimePool['acquire']>[0] {
  const sessionId = randomUUID();
  const runId = randomUUID();
  const input: HarnessExecutionInput = {
    kernel: {
      schemaVersion: 1,
      harness: 'dsh',
      employeeAssignmentId: randomUUID(),
      employeeVersionId: randomUUID(),
      sessionId,
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      systemInstructions: 'Synthetic session reuse; no model calls.',
      userRequest: 'Synthetic',
      bootstrapConversation: '',
      authorizedMemoryContext: '',
      grantedCapabilities: [],
      skillVersionIds: [],
      imageAttachments: [],
    },
    providerSnapshot: {
      provider: 'dsh',
      route: 'openai-compatible',
      authMode: 'allrice_credential',
      model: 'synthetic-model',
      credentialReference: 'test:synthetic',
      baseUrl: 'http://127.0.0.1:1/v1',
      reasoningEffort: 'none',
    },
    executionEnvironment: {
      ALLRICE_ORGANIZATION_ID: randomUUID(),
      ALLRICE_WORKSPACE_ID: randomUUID(),
      ALLRICE_OWNER_ID: randomUUID(),
      ALLRICE_RUN_ID: runId,
    },
    assistants: {
      rootRunId: runId,
      maxOutputTokens: 1000,
      bind: async () => {
        throw Error('Pool acquisition must not dispatch a model or controller');
      },
    },
    maxOutputTokens: 1000,
    tools: [],
    storageObjects: [],
    workDirectory: root,
    signal: new AbortController().signal,
    attempt: 1,
    generation: 0,
    onEvent: async () => {},
  };
  return {
    input,
    snapshot: input.providerSnapshot as Parameters<
      DshRuntimePool['acquire']
    >[0]['snapshot'],
    threadId: `dsh-${sessionId}`,
    systemInstructions: input.kernel.systemInstructions,
    nativeSkills: [],
  };
}

it('reuses the session process across business Runs with assistants enabled', async () => {
  const runtimes = pool();
  const first = request();
  const cold = await runtimes.acquire(first);
  const close = vi.spyOn(cold.runtime.client, 'close');
  const nextRun = randomUUID();
  const warm = await runtimes.acquire({
    ...first,
    input: {
      ...first.input,
      assistants: { ...first.input.assistants!, rootRunId: nextRun },
      executionEnvironment: {
        ...first.input.executionEnvironment,
        ALLRICE_RUN_ID: nextRun,
      },
    },
  });
  expect(cold.fresh).toBe(true);
  expect(warm.fresh).toBe(false);
  expect(warm.runtime).toBe(cold.runtime);
  expect(close).not.toHaveBeenCalled();
});

it.each(['assistant mode', 'assistant output cap', 'ordinary output cap'])(
  'restarts when process configuration changes: %s',
  async (change) => {
    const runtimes = pool();
    const first = request();
    if (change === 'ordinary output cap') first.input.assistants = undefined;
    const cold = await runtimes.acquire(first);
    const close = vi.spyOn(cold.runtime.client, 'close');
    if (change === 'assistant mode') first.input.assistants = undefined;
    else if (first.input.assistants)
      first.input.assistants.maxOutputTokens = 500;
    else first.input.maxOutputTokens = 500;
    const changed = await runtimes.acquire(first);
    expect(changed.fresh).toBe(true);
    expect(changed.runtime).not.toBe(cold.runtime);
    expect(close).toHaveBeenCalledOnce();
  },
);

it('the actual DSH host releases the old Run binding and accepts a new Run on the same warm process', async () => {
  const runtimes = pool(true);
  const first = request();
  const cold = await runtimes.acquire(first);
  const bind = () => ({
    nativeSessionId: first.threadId,
    runId: first.input.assistants!.rootRunId,
    wireTools: [],
  });
  await expect(cold.runtime.client.assistant('bind', bind())).resolves.toEqual({
    bound: true,
  });
  // The real host must still reject overlapping authority before finish.
  await expect(cold.runtime.client.assistant('bind', bind())).rejects.toThrow();
  await expect(
    cold.runtime.client.assistant('finish', {
      nativeSessionId: first.threadId,
    }),
  ).resolves.toEqual({ released: true });
  first.input.assistants!.rootRunId = randomUUID();
  const warm = await runtimes.acquire(first);
  expect(warm.fresh).toBe(false);
  expect(warm.runtime).toBe(cold.runtime);
  await expect(warm.runtime.client.assistant('bind', bind())).resolves.toEqual({
    bound: true,
  });
  await warm.runtime.client.assistant('finish', {
    nativeSessionId: first.threadId,
  });
}, 30_000);
