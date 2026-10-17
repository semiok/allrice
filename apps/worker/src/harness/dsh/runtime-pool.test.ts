import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HarnessExecutionInput } from '../adapter.js';
import * as CodexSubscription from '../../codex-subscription-home.js';
import { DshRuntimePool, configuredDshNativeLaunch } from './runtime-pool.js';

let root: string;
const pools: DshRuntimePool[] = [];

it('uses identical deployment defaults for startup and runtime construction', () => {
  expect(configuredDshNativeLaunch()).toEqual({
    command: process.execPath,
    args: [
      resolve(import.meta.dirname, '../../../dsh/allrice-jsonrpc-runtime.mjs'),
    ],
    profile: resolve(
      import.meta.dirname,
      '../../../dsh/allrice-restricted.cordis.yml',
    ),
  });
});

it('retains explicit constructor precedence over parsed deployment overrides', () => {
  vi.stubEnv('ALLRICE_DSH_RUNTIME_COMMAND', '/deployment/node');
  vi.stubEnv('ALLRICE_DSH_RUNTIME_ARGS', '["/deployment/entry.mjs"]');
  vi.stubEnv('ALLRICE_DSH_CORDIS_CONFIG', '/deployment/profile.yml');
  expect(configuredDshNativeLaunch()).toEqual({
    command: '/deployment/node',
    args: ['/deployment/entry.mjs'],
    profile: '/deployment/profile.yml',
  });
  expect(
    configuredDshNativeLaunch({
      runtimeCommand: process.execPath,
      runtimeArgs: ['/approved/entry.mjs'],
      cordisConfig: '/approved/profile.yml',
    }),
  ).toEqual({
    command: process.execPath,
    args: ['/approved/entry.mjs'],
    profile: '/approved/profile.yml',
  });
});

it('rejects malformed deployment arguments before any launch', () => {
  vi.stubEnv('ALLRICE_DSH_RUNTIME_ARGS', '{"not":"arguments"}');
  expect(() => configuredDshNativeLaunch()).toThrow('ALLRICE_DSH_RUNTIME_ARGS');
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allrice-runtime-reuse-'));
  vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(root, 'platform'));
});
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function pool(native = false, capturePrompt?: string) {
  const fixturePath = resolve(
    import.meta.dirname,
    native
      ? '../../../dsh/allrice-jsonrpc-runtime.mjs'
      : '../fixtures/dsh-fake-runtime.mjs',
  );
  const instance = new DshRuntimePool({
    runtimeRoot: join(root, 'runtime'),
    runtimeCommand: process.execPath,
    runtimeArgs: capturePrompt
      ? [
          '--input-type=module',
          '--eval',
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(capturePrompt)}, process.env.DSH_SYSTEM_PROMPT); await import(${JSON.stringify(pathToFileURL(fixturePath).href)});`,
        ]
      : [fixturePath],
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

async function codexRequest() {
  const platform = join(root, 'platform');
  await mkdir(platform, { recursive: true });
  vi.spyOn(CodexSubscription, 'activeCodexSubscriptionHome').mockResolvedValue(
    platform,
  );
  const path = join(platform, '.credentials.yaml');
  const document = `version: 1
refs: {}
records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload:
      type: oauth
      access: synthetic-only-one
      refresh: synthetic-refresh
      expires: 4102444800000
      accountId: synthetic-account
`;
  const timestamp = new Date('2026-01-01T00:00:00Z');
  await writeFile(path, document, { mode: 0o600 });
  await utimes(path, timestamp, timestamp);
  const input = request();
  input.snapshot = {
    ...input.snapshot,
    route: 'openai-codex',
    authMode: 'platform_subscription',
    credentialReference: 'test:codex',
    model: 'gpt-6.1-sol',
  };
  input.input.providerSnapshot = input.snapshot;
  return { input, path, document, timestamp };
}

it.each([false, true])(
  'keeps a warm Codex runtime when the credential file is replaced with identical bytes (native=%s)',
  async (native) => {
    const { input, path, document, timestamp } = await codexRequest();
    const runtimes = pool(native);
    const cold = await runtimes.acquire(input);
    const close = vi.spyOn(cold.runtime.client, 'close');
    await writeFile(path + '.replacement', document, { mode: 0o600 });
    await rename(path + '.replacement', path);
    const rewrittenAt = new Date(timestamp.getTime() + 1000);
    await utimes(path, rewrittenAt, rewrittenAt);

    const warm = await runtimes.acquire(input);
    expect(warm.fresh).toBe(false);
    expect(warm.runtime).toBe(cold.runtime);
    expect(warm.preparation).toMatchObject({
      cache: 'hit',
      reason: 'reused',
      changedFields: [],
      initializeMs: 0,
    });
    expect(close).not.toHaveBeenCalled();
    if (native)
      await expect(warm.runtime.client.providerStatus()).resolves.toMatchObject(
        {
          configured: true,
        },
      );
  },
  30_000,
);

it.each([false, true])(
  'rebuilds a Codex runtime when credential bytes change even if file size and mtime are preserved (native=%s)',
  async (native) => {
    const { input, path, document, timestamp } = await codexRequest();
    const runtimes = pool(native);
    const cold = await runtimes.acquire(input);
    const close = vi.spyOn(cold.runtime.client, 'close');
    const original = await stat(path);
    await writeFile(path, document.replace('one', 'two'));
    await utimes(path, timestamp, timestamp);
    const changedMetadata = await stat(path);
    expect(changedMetadata.size).toBe(original.size);
    expect(changedMetadata.mtimeMs).toBe(original.mtimeMs);

    const changed = await runtimes.acquire(input);
    expect(changed.fresh).toBe(true);
    expect(changed.runtime).not.toBe(cold.runtime);
    expect(changed.preparation).toMatchObject({
      cache: 'miss',
      reason: 'configuration_changed',
      changedFields: ['credentialDigest'],
    });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.stringify(changed.preparation)).not.toContain('synthetic-only');
  },
  30_000,
);

it('refuses warm Codex reuse after the credential file is removed', async () => {
  const { input, path } = await codexRequest();
  const runtimes = pool();
  await runtimes.acquire(input);
  await rm(path);
  await expect(runtimes.acquire(input)).rejects.toMatchObject({
    code: 'CODEX_SUBSCRIPTION_AUTH_REQUIRED',
  });
});

it('rebuilds after switching subscription slots even with identical credential bytes', async () => {
  const { input, document } = await codexRequest();
  const runtimes = pool();
  const cold = await runtimes.acquire(input);
  const otherHome = join(root, 'platform', 'codex-subscriptions', '2');
  await mkdir(otherHome, { recursive: true });
  await writeFile(join(otherHome, '.credentials.yaml'), document, {
    mode: 0o600,
  });
  vi.mocked(CodexSubscription.activeCodexSubscriptionHome).mockResolvedValue(
    otherHome,
  );

  const switched = await runtimes.acquire(input);
  expect(switched.fresh).toBe(true);
  expect(switched.runtime).not.toBe(cold.runtime);
  expect(switched.preparation.changedFields).toEqual(['codexSubscriptionHome']);
});

it.each([false, true])(
  'scopes the actual DSH startup prompt without granting managed Office (office supplied=%s)',
  async (officeSupplied) => {
    vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '0');
    const promptPath = join(root, 'synthetic-system-prompt.txt');
    const runtimes = pool(false, promptPath);
    const first = request();
    if (officeSupplied)
      first.input.tools = [
        {
          name: 'workspace.export.create',
          description: 'Managed Office export',
          inputSchema: { type: 'object' },
        },
      ];
    const started = await runtimes.acquire(first);
    const prompt = await readFile(promptPath, 'utf8');
    expect(prompt).toContain(first.systemInstructions);
    expect(prompt).toContain('on the DSH Worker host is disabled');
    expect(prompt).toContain('within their frozen authorization');
    expect(prompt).not.toContain('All host capabilities are disabled');
    expect(prompt.includes('independent of local.process.execute')).toBe(
      officeSupplied,
    );
    expect(started.runtime.nativeTools).toEqual(
      officeSupplied ? ['workspace.export.create'] : [],
    );
  },
);

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
  expect(cold.preparation).toMatchObject({
    cache: 'miss',
    reason: 'not_resident',
    changedFields: [],
    skillRegistrationMs: null,
  });
  expect(warm.fresh).toBe(false);
  expect(warm.preparation).toMatchObject({
    cache: 'hit',
    reason: 'reused',
    changedFields: [],
    initializeMs: 0,
    skillRegistrationMs: 0,
  });
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
    expect(changed.preparation).toMatchObject({
      cache: 'miss',
      reason: 'configuration_changed',
      changedFields: [
        change === 'assistant mode' ? 'assistantsEnabled' : 'maxTokens',
      ],
    });
    expect(JSON.stringify(changed.preparation)).not.toContain('synthetic-only');
    expect(changed.runtime).not.toBe(cold.runtime);
    expect(close).toHaveBeenCalledOnce();
  },
);

it('the actual DSH host releases the old Run binding and accepts a new Run on the same warm process', async () => {
  const runtimes = pool(true);
  const first = request();
  const cold = await runtimes.acquire(first);
  expect(cold.preparation.skillRegistrationMs).toBeGreaterThanOrEqual(0);
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
