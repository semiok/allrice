import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessExecutionInput } from '../adapter.js';
import { DshHarnessAdapter } from '../dsh-adapter.js';
import {
  DshProtocolClient,
  type DshNotification,
} from '../dsh-protocol-client.js';
import { DshRuntimePool, type DshRuntime } from './runtime-pool.js';
import { getAssistantFailureDiagnostics } from './assistant-diagnostics.js';
import { assertAssistantTaskComplete } from './assistant-outcome.js';

afterEach(() => vi.restoreAllMocks());

/** Adapter bookkeeping unit seam only: no native host or provider. Actual
 * native/RPC/PG correlation is covered by the loopback Gemini integration. */
function fixture(options: {
  originalError?: Error;
  diagnosticFailure?: boolean;
  malformed?: boolean;
  ordinary?: boolean;
  outcome?: 'partial' | 'completed' | 'unknown';
}) {
  const sessionId = randomUUID();
  const threadId = `dsh-${sessionId}`;
  const order: string[] = [];
  let notify: ((value: DshNotification) => void) | undefined;
  let cleared = false;
  const diagnostics = {
    version: 1,
    failures: [
      {
        nativeSessionId: randomUUID(),
        callId: randomUUID(),
        phase: 'finish',
        code: 'SERVER',
        stopKind: 'error',
        inputUsageKnown: false,
        outputUsageKnown: false,
        settlementConfirmed: true,
      },
    ],
    truncated: false,
  };
  const client = {
    setRequestHandler: vi.fn(),
    subscribe: (listener: (value: DshNotification) => void) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    prompt: async () => {
      if (options.originalError) throw options.originalError;
      notify?.({
        method: 'session.event',
        params: {
          sessionId: threadId,
          event: {
            type: 'assistant/message',
            seq: 1,
            time: Date.now(),
            data: {
              turn: 1,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'synthetic' }],
              },
              usage: { inputTokens: 10, outputTokens: 2 },
            },
          },
        },
      });
      notify?.({
        method: 'session.status',
        params: { sessionId: threadId, status: 'idle' },
      });
      return {};
    },
    assistant: vi.fn(async (action: string) => {
      order.push(action);
      if (action === 'diagnostics') {
        if (options.diagnosticFailure)
          throw Error('diagnostic-endpoint-failed');
        if (options.malformed)
          return { ...diagnostics, secret: 'must-not-copy' };
        return cleared
          ? { version: 1, failures: [], truncated: false }
          : diagnostics;
      }
      if (action === 'finish') cleared = true;
      if (action === 'join') return { answer: 'synthetic' };
      return {};
    }),
    sessionProjection: async () => ({ contextPressure: null }),
  };
  const runtime = { client, sessionId: threadId } as unknown as DshRuntime;
  vi.spyOn(DshRuntimePool.prototype, 'acquire').mockResolvedValue({
    runtime,
    fresh: true,
  });
  vi.spyOn(DshRuntimePool.prototype, 'touch').mockImplementation(() => {});
  vi.spyOn(DshRuntimePool.prototype, 'drop').mockImplementation(async () => {
    order.push('drop');
  });
  const input: HarnessExecutionInput = {
    kernel: {
      schemaVersion: 1,
      harness: 'dsh',
      employeeAssignmentId: randomUUID(),
      employeeVersionId: randomUUID(),
      sessionId,
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      systemInstructions: 'Synthetic',
      userRequest: 'Synthetic',
      bootstrapConversation: '',
      authorizedMemoryContext: '',
      grantedCapabilities: ['model:invoke'],
      skillVersionIds: [],
      imageAttachments: [],
    },
    providerSnapshot: {
      provider: 'dsh',
      authMode: 'allrice_credential',
      route: 'gemini',
      model: '3.8flash',
      reasoningEffort: 'low',
      credentialReference: 'test:never-read',
      baseUrl: null,
    },
    storageObjects: [],
    workDirectory: '/synthetic',
    executionEnvironment: {},
    signal: new AbortController().signal,
    attempt: 1,
    generation: 1,
    threadId,
    tools: [],
    onEvent: async () => {},
    assistants: options.ordinary
      ? undefined
      : {
          rootRunId: randomUUID(),
          bind: async () => ({
            handle: async () => ({}),
            cancellation: async () => ({ instances: [] }),
            cancel: async () => {
              order.push('cancel');
            },
            finish: async () => ({
              status: options.outcome ?? 'unknown',
              usageComplete:
                options.outcome !== undefined && options.outcome !== 'unknown',
              costEstimateAvailable: false,
              cacheUsageKnown: false,
              usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 },
            }),
          }),
        },
  };
  return {
    input,
    client,
    order,
    diagnostics,
    adapter: new DshHarnessAdapter(),
  };
}

describe('bounded assistant diagnostic consumption', () => {
  it('keeps partial return diagnostics through the later Worker completion error without serializable fields', async () => {
    const f = fixture({ outcome: 'partial' });
    const result = await f.adapter.execute(f.input);
    expect(result.assistantStatus).toBe('partial');
    expect(result.usageComplete).toBe(true);
    expect(getAssistantFailureDiagnostics(result)).toEqual(f.diagnostics);
    expect(JSON.stringify(result)).not.toContain('SERVER');
    expect(result).not.toHaveProperty('diagnostics');
    let error: unknown;
    try {
      assertAssistantTaskComplete(result);
    } catch (failure) {
      error = failure;
    }
    expect(error).toMatchObject({
      code: 'ASSISTANT_PARTIAL_RESULT',
      retryable: false,
    });
    expect(getAssistantFailureDiagnostics(error)).toEqual(f.diagnostics);
  });
  it('does not change a complete result merely because diagnostic observations exist', async () => {
    const f = fixture({ outcome: 'completed' });
    const result = await f.adapter.execute(f.input);
    expect(() => assertAssistantTaskComplete(result)).not.toThrow();
    expect(result.assistantStatus).toBe('completed');
    expect(result.usageComplete).toBe(true);
    expect(getAssistantFailureDiagnostics(result)).toEqual(f.diagnostics);
  });
  it('reads diagnostics before native finish clears them and retains them through unresolved failure', async () => {
    const f = fixture({});
    const error = await f.adapter
      .execute(f.input)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'ASSISTANT_EXECUTION_UNRESOLVED',
      retryable: false,
    });
    expect(getAssistantFailureDiagnostics(error)).toEqual(f.diagnostics);
    expect(f.order.indexOf('diagnostics')).toBeLessThan(
      f.order.indexOf('finish'),
    );
    expect(f.order.filter((item) => item === 'diagnostics')).toHaveLength(1);
    expect(f.order).toContain('drop');
  });
  it('captures a thrown failure before cancel/drop without replacing the original object', async () => {
    const original = Object.freeze(
      Object.assign(Error('not-diagnostic-evidence'), { retryable: false }),
    );
    const f = fixture({ originalError: original });
    const error = await f.adapter
      .execute(f.input)
      .catch((error: unknown) => error);
    expect(error).toBe(original);
    expect(getAssistantFailureDiagnostics(error)).toEqual(f.diagnostics);
    expect(f.order.indexOf('diagnostics')).toBeLessThan(
      f.order.indexOf('cancel'),
    );
    expect(f.order.indexOf('diagnostics')).toBeLessThan(
      f.order.indexOf('drop'),
    );
  });
  it.each(['diagnosticFailure', 'malformed'] as const)(
    'a %s snapshot neither replaces the original error nor relaxes accounting',
    async (key) => {
      const original = Error('original');
      const f = fixture({ originalError: original, [key]: true });
      const error = await f.adapter
        .execute(f.input)
        .catch((error: unknown) => error);
      expect(error).toBe(original);
      expect(getAssistantFailureDiagnostics(error)).toBeUndefined();
      expect(f.order).toContain('drop');
    },
  );
  it('does not invoke diagnostic RPCs or attach assistant context for ordinary chat', async () => {
    const original = Error('ordinary');
    const f = fixture({ originalError: original, ordinary: true });
    const error = await f.adapter
      .execute(f.input)
      .catch((error: unknown) => error);
    expect(error).toBe(original);
    expect(f.client.assistant).not.toHaveBeenCalled();
    expect(getAssistantFailureDiagnostics(error)).toBeUndefined();
  });
  it('removes a stalled diagnostic RPC after its own 2s deadline, not the 5min model deadline', async () => {
    // A minimal local JSON-RPC process; it deliberately ignores diagnostics.
    const client = new DshProtocolClient({
      command: process.execPath,
      args: [
        '-e',
        "require('node:readline').createInterface({input:process.stdin}).on('line',s=>{const f=JSON.parse(s);if(f.method==='shutdown'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result:{}})+'\\n');process.exit(0);}})",
      ],
      cwd: process.cwd(),
      environment: {},
      requestTimeoutMs: 300000,
    });
    try {
      const started = performance.now();
      await expect(
        client.assistant('diagnostics', { nativeSessionId: 'synthetic' }),
      ).rejects.toMatchObject({ code: 'DSH_REQUEST_TIMEOUT' });
      expect(performance.now() - started).toBeLessThan(5000);
      expect(
        (client as unknown as { pending: Map<number, unknown> }).pending.size,
      ).toBe(0);
    } finally {
      await client.close();
    }
  }, 10000);
});
