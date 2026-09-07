import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DshExecutionSnapshot,
  ResolvedModelTarget,
  RouteDecision,
} from '@allrice/contracts';
import type { HarnessExecutionInput } from '../adapter.js';
import type { DshProtocolLaunch } from '../dsh-protocol-client.js';
import { DshRuntimePool } from './runtime-pool.js';
import {
  providerSnapshotForModelTarget,
  replayProviderSnapshot,
} from '../../routing/provider-snapshot.js';

const captured = vi.hoisted(() => [] as DshProtocolLaunch[]);
vi.mock('../dsh-protocol-client.js', () => ({
  DshProtocolClient: class {
    constructor(input: DshProtocolLaunch) {
      captured.push(input);
    }
    initialize = vi.fn(async () => ({}));
    close = vi.fn(async () => {});
  },
}));
let root: string;
let pool: DshRuntimePool;
const resolveCredential = vi.fn(async () => ({
  apiKey: 'selected-synthetic-key',
}));
function request(route: DshExecutionSnapshot['route'] = 'gemini') {
  const snapshot: DshExecutionSnapshot = {
    provider: 'dsh',
    route,
    authMode:
      route === 'openai-codex' ? 'platform_subscription' : 'allrice_credential',
    model: route === 'gemini' ? '3.8flash' : 'synthetic-model',
    reasoningEffort: 'high',
    credentialReference: `test:${route}`,
    baseUrl: null,
  };
  return {
    snapshot,
    threadId: randomUUID(),
    systemInstructions: 'synthetic',
    nativeSkills: [],
    input: {
      kernel: {
        schemaVersion: 1,
        harness: 'dsh',
        employeeAssignmentId: randomUUID(),
        employeeVersionId: randomUUID(),
        sessionId: randomUUID(),
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        systemInstructions: 'synthetic',
        userRequest: 'synthetic',
        bootstrapConversation: '',
        authorizedMemoryContext: '',
        grantedCapabilities: [],
        skillVersionIds: [],
        imageAttachments: [],
      },
      providerSnapshot: snapshot,
      storageObjects: [],
      workDirectory: root,
      signal: new AbortController().signal,
      attempt: 1,
      generation: 0,
      onEvent: async () => {},
      tools: [],
      executionEnvironment: {
        ALLRICE_ORGANIZATION_ID: randomUUID(),
        ALLRICE_WORKSPACE_ID: randomUUID(),
        ALLRICE_OWNER_ID: randomUUID(),
      },
    } satisfies HarnessExecutionInput,
  };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allrice-gemini-compat-'));
  vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', root);
  vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '');
  vi.stubEnv('GEMINI_API_KEY', 'ambient-must-not-leak');
  captured.length = 0;
  resolveCredential.mockClear();
  pool = new DshRuntimePool({
    credentialResolver: { resolve: resolveCredential },
    runtimeRoot: root,
  });
});
afterEach(async () => {
  await pool.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('Gemini opt-in and credential isolation', () => {
  it.each(['none', 'xhigh'] as const)(
    'rejects Gemini %s before resolving credentials',
    async (effort) => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
      const input = request();
      input.snapshot.reasoningEffort = effort;
      await expect(pool.acquire(input)).rejects.toMatchObject({
        code: 'GEMINI_REASONING_UNSUPPORTED',
      });
      expect(resolveCredential).not.toHaveBeenCalled();
      expect(captured).toHaveLength(0);
    },
  );
  it.each(['low', 'medium', 'high'] as const)(
    'passes Gemini %s without DeepSeek remapping',
    async (effort) => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
      const input = request();
      input.snapshot.reasoningEffort = effort;
      await pool.acquire(input);
      expect(captured[0]?.environment.DSH_GEMINI_REASONING_EFFORT).toBe(effort);
      expect(
        JSON.parse(
          captured[0]?.environment.DSH_GEMINI_REASONING_LEVELS ?? '{}',
        ),
      ).toEqual({ low: 'LOW', medium: 'MEDIUM', high: 'HIGH' });
    },
  );
  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
    'passes Codex %s unchanged',
    async (effort) => {
      await writeFile(join(root, '.credentials.yaml'), '{}', { mode: 0o600 });
      const input = request('openai-codex');
      input.snapshot.reasoningEffort = effort;
      await pool.acquire(input);
      expect(captured[0]?.environment.DSH_CODEX_REASONING_EFFORT).toBe(effort);
    },
  );
  it('denies before resolving credentials or starting a child by default', async () => {
    await expect(pool.acquire(request())).rejects.toMatchObject({
      code: 'GEMINI_API_DISABLED',
    });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });
  it('resolves only the selected scoped key and preserves the old model identity outside transport', async () => {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
    const input = request();
    await pool.acquire(input);
    expect(resolveCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: 'test:gemini',
        route: 'gemini',
        organizationId:
          input.input.executionEnvironment.ALLRICE_ORGANIZATION_ID,
      }),
    );
    expect(captured[0]?.environment.GEMINI_API_KEY).toBe(
      'selected-synthetic-key',
    );
    expect(captured[0]?.environment.DSH_GEMINI_MODEL).toBe('gemini-3.8-flash');
    expect(captured[0]?.environment.OPENAI_COMPATIBLE_API_KEY).toBeUndefined();
    expect(pool.inventory()[0]?.model).toBe('3.8flash');
    expect(JSON.stringify(pool.inventory())).not.toContain('synthetic-key');
  });
  it('never falls back to an ambient key when the authorized reference is unavailable', async () => {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
    resolveCredential.mockRejectedValueOnce(
      new Error('synthetic credential missing'),
    );
    await expect(pool.acquire(request())).rejects.toThrow(
      'synthetic credential missing',
    );
    expect(captured).toHaveLength(0);
  });
  it('keeps Codex child free of Gemini keys with a Gemini environment variable present', async () => {
    await writeFile(join(root, '.credentials.yaml'), '{}', { mode: 0o600 });
    await pool.acquire(request('openai-codex'));
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(captured[0]?.environment.GEMINI_API_KEY).toBeUndefined();
    expect(JSON.stringify(captured)).not.toContain('ambient-must-not-leak');
  });
  it('does not expose a Gemini key to another API provider', async () => {
    await pool.acquire(request('deepseek-official'));
    expect(captured[0]?.environment.DEEPSEEK_API_KEY).toBe(
      'selected-synthetic-key',
    );
    expect(captured[0]?.environment.GEMINI_API_KEY).toBeUndefined();
  });
  it('accepts legacy subscription-labeled history but still resolves an API credential', async () => {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
    const input = request();
    input.snapshot.authMode = 'platform_subscription';
    await pool.acquire(input);
    expect(resolveCredential).toHaveBeenCalledOnce();
    expect(captured[0]?.environment.GEMINI_API_KEY).toBe(
      'selected-synthetic-key',
    );
  });
  it('does not reinterpret a Zhipu/OAuth target as a runnable compatible API', () => {
    expect(() =>
      providerSnapshotForModelTarget({
        provider: 'zhipu',
        authMode: 'gemini_oauth',
      } as ResolvedModelTarget),
    ).toThrow('authorization mode');
  });
  it('does not synthesize Gemini credentials or reuse a same-name model on another route during replay', () => {
    const original = request('deepseek-official').snapshot;
    const decision = {
      harness: 'dsh',
      provider: 'gemini',
      model: original.model,
    } as RouteDecision;
    expect(() =>
      replayProviderSnapshot({ original, decision, reasoningEffort: 'medium' }),
    ).toThrow('original frozen');
    const frozen = { ...original, route: 'gemini' as const };
    expect(
      replayProviderSnapshot({
        original: frozen,
        decision,
        reasoningEffort: 'medium',
      }),
    ).toEqual(frozen);
  });
  it('matches an explicitly selected fallback in the other direction and rejects unmatched provider replay', () => {
    const original = request().snapshot;
    const fallback = {
      ...original,
      route: 'openai-compatible' as const,
      credentialReference: 'synthetic:gateway',
      baseUrl: 'https://example.invalid/v1',
    };
    const decision = {
      harness: 'dsh',
      provider: 'openai-compatible',
      model: original.model,
    } as RouteDecision;
    expect(
      replayProviderSnapshot({
        original,
        fallbacks: [fallback],
        decision,
        reasoningEffort: 'medium',
      }),
    ).toEqual(fallback);
    expect(() =>
      replayProviderSnapshot({ original, decision, reasoningEffort: 'medium' }),
    ).toThrow('original frozen');
    expect(() =>
      replayProviderSnapshot({
        original,
        decision: { ...decision, model: 'different-model' },
        reasoningEffort: 'medium',
      }),
    ).toThrow('original frozen');
  });
});
