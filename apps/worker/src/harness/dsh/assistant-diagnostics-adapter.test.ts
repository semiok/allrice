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
import {
  assertAssistantTaskComplete,
  getAssistantFailureUsage,
  type AssistantFailureUsage,
} from './assistant-outcome.js';
import { AssistantRuntimeError } from '@allrice/database';
import { DSH_INSTALLED_DISTRIBUTION } from '@allrice/contracts';
import { HandlerError } from '../../errors.js';
import { getDshCleanupFailures } from '../dsh-client-cleanup.js';
import { DshStartupRejection } from './startup-rejection.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Adapter bookkeeping unit seam only: no native host or provider. Actual
 * native/RPC/PG correlation is covered by the loopback Gemini integration. */
function fixture(options: {
  originalError?: Error;
  diagnosticFailure?: boolean;
  malformed?: boolean;
  ordinary?: boolean;
  outcome?: 'partial' | 'completed' | 'unknown';
  failureUsage?: AssistantFailureUsage;
  failureUsageError?: boolean;
  drainError?: boolean;
  drainHang?: boolean;
  nativeReadmissionFailure?: Error;
  recoverHang?: boolean;
  admissionFailure?: boolean;
  admissionFailureReturned?: boolean;
  admissionMethod?: string;
  authorityFailure?: Error;
  rootTimeout?: boolean;
  cancelHang?: boolean;
  closeFailure?: boolean;
  streamDiagnostic?: unknown;
  modelTimings?: Record<string, unknown>[];
  joinTimings?: Record<string, unknown>[];
  drainTimings?: Record<string, unknown>[];
}) {
  const sessionId = randomUUID();
  const threadId = `dsh-${sessionId}`;
  const order: string[] = [];
  const notificationListeners = new Set<(value: DshNotification) => void>();
  const notify = (value: DshNotification) => {
    for (const listener of [...notificationListeners]) listener(value);
  };
  let cleared = false;
  const abort = new AbortController();
  let rejectPrompt: ((error: Error) => void) | undefined;
  let rejectRecover: ((error: Error) => void) | undefined;
  let handler:
    | ((method: string, params: Record<string, unknown>) => Promise<unknown>)
    | null;
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
    // The adapter closes the captured runtime directly. Keep the existing
    // disposal-order label while settling this fake client's pending RPCs.
    close: vi.fn(async () => {
      order.push('drop');
      rejectRecover?.(Error('owned recovery host closed'));
      rejectPrompt?.(new Error('native runtime closed'));
      if (options.closeFailure) throw Error('native shutdown unconfirmed');
    }),
    interrupt: vi.fn(async () => ({})),
    recover: vi.fn(async () => {
      order.push('recover');
      return options.recoverHang
        ? new Promise((_, reject) => {
            rejectRecover = reject;
          })
        : { recovered: true };
    }),
    onFailure: vi.fn(() => () => {}),
    setRequestHandler: vi.fn((value) => {
      handler = value;
    }),
    subscribe: (listener: (value: DshNotification) => void) => {
      notificationListeners.add(listener);
      return () => {
        notificationListeners.delete(listener);
      };
    },
    prompt: vi.fn(async () => {
      for (const params of options.modelTimings ?? [])
        notify?.({ method: 'allrice.modelTiming', params });
      if (options.streamDiagnostic)
        notify?.({
          method: 'allrice.modelStream',
          params: {
            sessionId: threadId,
            callId: diagnostics.failures[0]!.callId,
            diagnostic: options.streamDiagnostic,
          },
        });
      if (options.authorityFailure || options.rootTimeout || options.cancelHang)
        return new Promise((_, reject) => {
          rejectPrompt = reject;
        });
      if (options.admissionFailure) {
        await handler?.(
          options.admissionMethod ?? 'allrice/assistant/model-dispatch',
          {},
        ).catch(() => {});
        if (!options.admissionFailureReturned)
          throw Error('native generic error');
      }
      if (options.originalError) throw options.originalError;
      notify?.({
        method: 'session.event',
        params: {
          sessionId: threadId,
          event: {
            type: 'turn/start',
            seq: 0,
            time: Date.now(),
            data: { turn: 1 },
          },
        },
      });
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
    }),
    assistant: vi.fn(async (action: string) => {
      order.push(action);
      for (const params of (action === 'join'
        ? options.joinTimings
        : action === 'drain'
          ? options.drainTimings
          : []) ?? [])
        notify({ method: 'allrice.modelTiming', params });
      if (action === 'drain' && options.rootTimeout)
        rejectPrompt?.(Error('native stopped'));
      if (action === 'drain' && options.drainError)
        throw Error('drain unavailable');
      if (action === 'drain' && options.drainHang) return new Promise(() => {});
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
  const runtime = {
    client,
    sessionId: threadId,
    nativeTools: [],
  } as unknown as DshRuntime;
  vi.spyOn(DshRuntimePool.prototype, 'acquire').mockResolvedValue({
    runtime,
    fresh: true,
    preparation: {
      cache: 'miss',
      reason: 'not_resident',
      changedFields: [],
      credentialResolutionMs: 0,
      previousRuntimeCloseMs: 0,
      initializeMs: 0,
      skillRegistrationMs: null,
      acquireMs: 0,
    },
  });
  vi.spyOn(DshRuntimePool.prototype, 'touch').mockImplementation(() => {});
  vi.spyOn(DshRuntimePool.prototype, 'drop').mockImplementation(() =>
    client.close(),
  );
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
    signal: abort.signal,
    attempt: 1,
    generation: 1,
    threadId,
    tools: [],
    onEvent: async () => {},
    assistants: options.ordinary
      ? undefined
      : {
          deliveryMode: 'legacy',
          rootRunId: randomUUID(),
          bind: async () => ({
            hasPriorRoot: false,
            handle: async () => {
              if (options.admissionFailure)
                throw new AssistantRuntimeError('budget_exhausted');
              return {};
            },
            cancellation: async () => {
              if (options.nativeReadmissionFailure || options.recoverHang) {
                order.push('cancellation');
                return {
                  nativeSessionId: threadId,
                  instances: [{ nativeSessionId: threadId }],
                };
              }
              if (options.authorityFailure) throw options.authorityFailure;
              return options.rootTimeout
                ? {
                    nativeSessionId: threadId,
                    instances: [{ nativeSessionId: threadId }],
                    stopReason: 'timeout' as const,
                    drainDeadlineAt: new Date(Date.now() + 30000).toISOString(),
                  }
                : { instances: [] };
            },
            cancel: async () => {
              order.push('cancel');
              if (options.cancelHang) await new Promise(() => {});
            },
            failureUsage:
              options.failureUsage || options.failureUsageError
                ? async () => {
                    order.push('failureUsage');
                    if (options.failureUsageError)
                      throw Error('ledger unavailable');
                    return options.failureUsage!;
                  }
                : undefined,
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
  if (options.nativeReadmissionFailure) {
    // Explicit descriptor/pin seam: real SQL rejection is covered in P25.
    // This case isolates the already-bound assistant's receipt/close order.
    const descriptor = {
      nativeSessionId: threadId,
      artifactId: `sha256:${'a'.repeat(64)}`,
      artifactManifestDigest: `sha256:${'a'.repeat(64)}`,
      distributionGeneration: DSH_INSTALLED_DISTRIBUTION.generation,
      profileId: 'restricted' as const,
      storageContextKey: sessionId,
      storageNamespace: '/synthetic/sessions',
    };
    vi.spyOn(DshRuntimePool.prototype, 'describeNativeSession').mockReturnValue(
      descriptor,
    );
    input.nativeBinding = {
      prepare: async () => ({ binding: null, requiresRecovery: false }),
      bind: vi
        .fn<NonNullable<HarnessExecutionInput['nativeBinding']>['bind']>()
        .mockResolvedValueOnce({
          binding: {
            ...descriptor,
            organizationId: randomUUID(),
            workspaceId: randomUUID(),
            ownerId: randomUUID(),
            contextKind: 'chat',
            contextId: sessionId,
            firstRunId: input.assistants!.rootRunId,
            firstJobId: randomUUID(),
            firstAttempt: 1,
            boundAt: new Date().toISOString(),
            bindingBasis: 'business_root_origin',
          },
          generation: 1,
        })
        .mockRejectedValue(options.nativeReadmissionFailure),
    };
  }
  if (options.recoverHang) {
    vi.spyOn(
      DshRuntimePool.prototype,
      'hasApprovedNativeLaunch',
    ).mockReturnValue(true);
    vi.spyOn(
      DshRuntimePool.prototype,
      'assertStoredSession',
    ).mockResolvedValue();
    const bound = syntheticPin(input);
    input.nativeBinding = {
      prepare: async () => ({ ...bound, requiresRecovery: true }),
      bind: vi.fn(async () => bound),
    };
  }
  return {
    input,
    client,
    notify,
    order,
    diagnostics,
    abort: () => abort.abort(),
    adapter: new DshHarnessAdapter(),
  };
}

function syntheticPin(input: HarnessExecutionInput) {
  const descriptor = DshRuntimePool.prototype.describeNativeSession(
    input,
    input.threadId!,
  )!;
  return {
    binding: {
      ...descriptor,
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
      contextKind: 'chat' as const,
      contextId: input.kernel.sessionId!,
      firstRunId: input.assistants?.rootRunId ?? randomUUID(),
      firstJobId: randomUUID(),
      firstAttempt: 1,
      boundAt: new Date().toISOString(),
      bindingBasis: 'business_root_origin' as const,
    },
    generation: 1,
  };
}

describe('bounded assistant diagnostic consumption', () => {
  it.each([true, false])(
    'bounds cancellation while cold recovery is waiting (ordinary %s)',
    async (ordinary) => {
      vi.useFakeTimers();
      const f = fixture({ ordinary, recoverHang: true });
      const cancel = new AbortController();
      f.input.signal = cancel.signal;
      const outcome = f.adapter
        .execute(f.input)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.client.recover).toHaveBeenCalledOnce();
      expect(f.client.prompt).not.toHaveBeenCalled();
      cancel.abort();
      await vi.advanceTimersByTimeAsync(25000);
      expect(await outcome).toMatchObject({ code: 'EXECUTION_ABORTED' });
      expect(f.order.filter((entry) => entry === 'drop')).toHaveLength(1);
      expect(f.order).not.toContain('finish');
      expect(f.client.prompt).not.toHaveBeenCalled();
    },
  );
  it.each(['available', 'unavailable', 'hanging'] as const)(
    'a post-initialize admission refusal preserves bounded assistant cleanup with %s drain',
    async (drain) => {
      vi.useFakeTimers();
      const denied = new HandlerError(
        'NATIVE_SESSION_ADMISSION_DENIED',
        'Synthetic lease revoked after initialize',
        false,
      );
      const receipt = {
        usage: { inputTokens: 120, outputTokens: 7, cachedInputTokens: 0 },
        usageComplete: false,
        cacheUsageKnown: false,
      };
      const f = fixture({
        nativeReadmissionFailure: denied,
        failureUsage: receipt,
        drainError: drain === 'unavailable',
        drainHang: drain === 'hanging',
      });
      const outcome = f.adapter
        .execute(f.input)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.input.nativeBinding!.bind).toHaveBeenCalledTimes(2);
      expect(f.client.prompt).not.toHaveBeenCalled();
      expect(f.order.slice(0, 5)).toEqual([
        'bind',
        'diagnostics',
        'cancel',
        'cancellation',
        'drain',
      ]);
      if (drain === 'hanging') {
        expect(f.order).not.toContain('drop');
        await vi.advanceTimersByTimeAsync(25000);
        expect(f.order).not.toContain('failureUsage');
      } else {
        expect(f.order.indexOf('drain')).toBeLessThan(
          f.order.indexOf('failureUsage'),
        );
        expect(f.order.indexOf('failureUsage')).toBeLessThan(
          f.order.indexOf('drop'),
        );
      }
      const error = await outcome;
      expect(error).toBe(denied);
      expect(getAssistantFailureDiagnostics(error)).toEqual(f.diagnostics);
      expect(
        getAssistantFailureUsage(error, f.input.assistants!.rootRunId, 1),
      ).toEqual(drain === 'hanging' ? undefined : receipt);
      expect(f.order.filter((action) => action === 'drop')).toHaveLength(1);
      expect(f.order).not.toContain('finish');
      expect(f.client.prompt).not.toHaveBeenCalled();
    },
  );
  it.each(['join', 'drain'] as const)(
    'keeps timing capture through %s and disposes it after final flush',
    async (action) => {
      const timing = {
        version: 1,
        phase: 'prepared',
        startedAt: new Date().toISOString(),
        elapsedMs: 2,
        preparationMs: 1,
        ledgerPreparationMs: 1,
        authorizationReadMs: null,
        firstChunkMs: null,
        firstContentMs: null,
        firstTextMs: null,
        firstReasoningMs: null,
        firstToolCallMs: null,
        transport: 'unobserved',
        requestCount: 0,
        websocketRequests: 0,
        requestsTruncated: false,
        httpRequests: [],
      };
      const frame = {
        sessionId: 'owned-native-child',
        callId: randomUUID(),
        timing,
      };
      const late = {
        ...frame,
        timing: {
          ...timing,
          phase: action === 'join' ? 'completed' : 'failed',
        },
      };
      const failure = new Error('synthetic model failure');
      const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
      const f = fixture({
        outcome: 'completed',
        modelTimings: [frame],
        ...(action === 'join'
          ? { joinTimings: [late, late] }
          : { originalError: failure, drainTimings: [late, late] }),
      });
      const runId = randomUUID();
      f.input.executionEnvironment = { ALLRICE_RUN_ID: runId };
      if (action === 'join') await f.adapter.execute(f.input);
      else await expect(f.adapter.execute(f.input)).rejects.toBe(failure);
      const rows = logs.mock.calls
        .filter((x) => x[0] === '[AllRice:model-timing]')
        .map((x) => JSON.parse(String(x[1])));
      expect(rows.map((x) => x.timing.phase)).toEqual([
        'prepared',
        action === 'join' ? 'completed' : 'failed',
      ]);
      expect(
        rows.every((x) => x.runId === runId && x.callId === frame.callId),
      ).toBe(true);
      const count = logs.mock.calls.length;
      f.notify({
        method: 'allrice.modelTiming',
        params: { ...frame, callId: randomUUID() },
      });
      expect(logs).toHaveBeenCalledTimes(count);
    },
  );
  it('logs validated call timing once with the root Run, without creating chat events', async () => {
    const timing = {
      version: 1,
      phase: 'prepared',
      startedAt: new Date().toISOString(),
      elapsedMs: 2,
      preparationMs: 2,
      ledgerPreparationMs: 1,
      authorizationReadMs: null,
      firstChunkMs: null,
      firstContentMs: null,
      firstTextMs: null,
      firstReasoningMs: null,
      firstToolCallMs: null,
      transport: 'unobserved',
      requestCount: 0,
      websocketRequests: 0,
      requestsTruncated: false,
      httpRequests: [],
    };
    const frame = {
      sessionId: 'owned-native-child',
      callId: randomUUID(),
      timing,
    };
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const f = fixture({
      outcome: 'completed',
      modelTimings: [
        frame,
        frame,
        { ...frame, timing: { ...timing, prompt: 'PRIVATE_PROMPT' } },
      ],
    });
    const runId = randomUUID();
    f.input.executionEnvironment = { ALLRICE_RUN_ID: runId };
    const onEvent = vi.fn(
      async (event: { type: string; sourceEventType?: string }) => {
        void event;
      },
    );
    f.input.onEvent = onEvent;
    await f.adapter.execute(f.input);
    const rows = logs.mock.calls.filter(
      (x) => x[0] === '[AllRice:model-timing]',
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]![1]))).toMatchObject({
      event: 'allrice.model_timing',
      runId,
      callId: frame.callId,
      nativeSessionId: frame.sessionId,
      timing,
    });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_PROMPT');
    expect(
      onEvent.mock.calls.some(
        ([event]) => event.sourceEventType === 'allrice/model-timing',
      ),
    ).toBe(false);
  });
  it('persists short connection-failure facts without calling them a long wait', async () => {
    const diagnostic = {
      transport: 'unobserved',
      state: 'unobserved',
      bytes: 0,
      heartbeats: 0,
      events: 0,
      terminalEvent: false,
      outputItemEnded: false,
      readFailed: false,
      localCloseConfirmed: false,
      finishSeen: true,
      recoveryEligible: false,
      request: {
        phase: 'request_failed',
        elapsedMs: 113,
        aborted: false,
        errorCode: 'ECONNRESET',
      },
    };
    const f = fixture({ streamDiagnostic: diagnostic, outcome: 'completed' });
    const onNative = vi.fn(async () => {});
    f.input.onEvent = onNative;
    await f.adapter.execute(f.input);
    expect(onNative).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceEventType: 'allrice/model-stream',
        sourcePayload: {
          callId: f.diagnostics.failures[0]!.callId,
          diagnostic,
        },
        summary:
          '模型响应中断，底层连接状态暂无法确认。已完成的内容和工具结果已保留。',
      }),
    );
  });
  it('preserves the durable execution deadline instead of generic runtime closure', async () => {
    vi.useFakeTimers();
    const f = fixture({
      authorityFailure: new AssistantRuntimeError('budget_exhausted'),
    });
    const outcome = f.adapter.execute(f.input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300);
    expect(await outcome).toMatchObject({
      code: 'ASSISTANT_BUDGET_EXHAUSTED',
      retryable: false,
      message: expect.stringContaining('执行时限'),
    });
    expect(f.order).toContain('drop');
  });
  it('a stop that outlives its drain window fails the Run, never the Worker process', async () => {
    // Node's EventTarget rethrows a rejected listener result as an uncaught
    // exception; on Dev this ended the Worker and orphaned the schedule
    // partitions (MET-210, 10-26 18:19).
    vi.useFakeTimers();
    const uncaught = vi.fn();
    process.prependListener('uncaughtException', uncaught);
    try {
      const f = fixture({ cancelHang: true });
      const outcome = f.adapter
        .execute(f.input)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(300);
      f.abort();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.order).toContain('cancel');
      expect(await outcome).toMatchObject({ code: 'EXECUTION_ABORTED' });
      // The drain window's cutoff closed the owned Host: no orphaned child.
      expect(f.order).toContain('drop');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.removeListener('uncaughtException', uncaught);
    }
  });
  it('a failed Host close after a failed authority poll stays inside the Run', async () => {
    // The poll's close failure rejects after cancellationTask is cleared; with
    // no observer Node's default unhandled-rejection mode ends the Worker.
    vi.useFakeTimers();
    const unhandled = vi.fn();
    const uncaught = vi.fn();
    process.prependListener('unhandledRejection', unhandled);
    process.prependListener('uncaughtException', uncaught);
    try {
      const f = fixture({
        authorityFailure: Error('lease lost'),
        closeFailure: true,
      });
      const outcome = f.adapter
        .execute(f.input)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await outcome).toBeInstanceOf(Error);
      expect(f.order).toContain('drop');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(unhandled).not.toHaveBeenCalled();
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
      process.removeListener('uncaughtException', uncaught);
    }
  });
  it('authority-first timeout drains and reads genuine usage before closing the owned host', async () => {
    vi.useFakeTimers();
    const receipt = {
      usage: { inputTokens: 120, outputTokens: 7, cachedInputTokens: 0 },
      usageComplete: false,
      cacheUsageKnown: false,
    };
    const f = fixture({ rootTimeout: true, failureUsage: receipt });
    const outcome = f.adapter.execute(f.input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300);
    expect(await outcome).toMatchObject({
      code: 'ASSISTANT_BUDGET_EXHAUSTED',
      retryable: false,
    });
    expect(f.order.indexOf('drain')).toBeGreaterThan(-1);
    expect(f.order.indexOf('drain')).toBeLessThan(
      f.order.indexOf('failureUsage'),
    );
    expect(f.order.indexOf('failureUsage')).toBeLessThan(
      f.order.indexOf('drop'),
    );
    expect(f.order.filter((x) => x === 'drain')).toHaveLength(1);
  });
  it.each([true, false])(
    'propagates known prior usage with completeness=%s, only after drain and before host disposal',
    async (usageComplete) => {
      const original = Object.freeze(Error('original'));
      const receipt = {
        usage: { inputTokens: 47002, outputTokens: 3214, cachedInputTokens: 0 },
        usageComplete,
        cacheUsageKnown: false,
      };
      const f = fixture({
        originalError: original,
        failureUsage: receipt,
        drainError: !usageComplete,
      });
      const error = await f.adapter
        .execute(f.input)
        .catch((error: unknown) => error);
      expect(error).toBe(original);
      expect(
        getAssistantFailureUsage(
          error,
          f.input.assistants!.rootRunId,
          f.input.attempt,
        ),
      ).toEqual(receipt);
      expect(f.order.indexOf('drain')).toBeLessThan(
        f.order.indexOf('failureUsage'),
      );
      expect(f.order.indexOf('failureUsage')).toBeLessThan(
        f.order.indexOf('drop'),
      );
      expect(f.order).not.toContain('finish');
    },
  );
  it('does not guess usage if durable accounting fails', async () => {
    const original = Error('original');
    const f = fixture({ originalError: original, failureUsageError: true });
    const error = await f.adapter
      .execute(f.input)
      .catch((error: unknown) => error);
    expect(error).toBe(original);
    expect(
      getAssistantFailureUsage(
        error,
        f.input.assistants!.rootRunId,
        f.input.attempt,
      ),
    ).toBeUndefined();
    expect(f.order).toContain('drop');
  });
  it.each(
    ['model-prepare', 'model-dispatch', 'delegate', 'development'].flatMap(
      (admissionMethod) =>
        [false, true].map((admissionFailureReturned) => ({
          admissionMethod,
          admissionFailureReturned,
        })),
    ),
  )(
    'a trusted local admission denial is non-retryable ($admissionMethod, $admissionFailureReturned)',
    async ({ admissionMethod, admissionFailureReturned }) => {
      const receipt = {
        usage: { inputTokens: 20, outputTokens: 3, cachedInputTokens: 0 },
        usageComplete: true,
        cacheUsageKnown: false,
      };
      const f = fixture({
        admissionFailure: true,
        admissionMethod: `allrice/assistant/${admissionMethod}`,
        admissionFailureReturned,
        failureUsage: receipt,
      });
      const error = await f.adapter
        .execute(f.input)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: 'ASSISTANT_BUDGET_EXHAUSTED',
        retryable: false,
      });
      expect(
        getAssistantFailureUsage(
          error,
          f.input.assistants!.rootRunId,
          f.input.attempt,
        ),
      ).toEqual(receipt);
    },
  );
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
  it.each([false, true])(
    'prevents retry after unconfirmed cleanup while retaining classification and usage (frozen %s)',
    async (frozen) => {
      const earlierCause = Error('earlier operation cause');
      const original = new HandlerError(
        'TRANSIENT_ADMISSION',
        'original transient failure',
        true,
        { cause: earlierCause },
      );
      if (frozen) Object.freeze(original);
      const receipt = {
        usage: { inputTokens: 120, cachedInputTokens: 8, outputTokens: 7 },
        usageComplete: false,
        cacheUsageKnown: false,
      };
      const closeFailure = new HandlerError(
        'DSH_RUNTIME_CLOSE_UNCONFIRMED',
        'unconfirmed synthetic close',
        false,
      );
      const f = fixture({ originalError: original, failureUsage: receipt });
      f.client.close.mockImplementation(async () => {
        f.order.push('drop');
        throw closeFailure;
      });
      const failure = await f.adapter.execute(f.input).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(HandlerError);
      expect(failure).toMatchObject({
        code: original.code,
        message: original.message,
        retryable: false,
        cause: original,
      });
      expect(original.retryable).toBe(true);
      expect(original.cause).toBe(earlierCause);
      expect(getDshCleanupFailures(failure)).toEqual([closeFailure]);
      expect(
        getAssistantFailureUsage(
          failure,
          f.input.assistants!.rootRunId,
          f.input.attempt,
        ),
      ).toEqual(receipt);
      expect(
        getAssistantFailureUsage(failure, randomUUID(), f.input.attempt),
      ).toBeUndefined();
      expect(getAssistantFailureDiagnostics(failure)).toEqual(f.diagnostics);
      expect(f.client.prompt).toHaveBeenCalledOnce();
      expect(f.order.indexOf('failureUsage')).toBeLessThan(
        f.order.indexOf('drop'),
      );
      expect(f.order.filter((x) => x === 'drop')).toHaveLength(1);
      expect(f.order).not.toContain('finish');
    },
  );
  it('captures a thrown failure before cancel/drop without replacing the original object', async () => {
    const original = Object.freeze(
      Object.assign(Error('not-diagnostic-evidence'), { retryable: false }),
    );
    const f = fixture({ originalError: original });
    const error = await f.adapter
      .execute(f.input)
      .catch((error: unknown) => error);
    expect(error).toBe(original);
    // No receipt after prompt is still unknown, even on a fresh native host.
    expect(error).not.toBeInstanceOf(DshStartupRejection);
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
    // A synthetic JSON-RPC process: ignores diagnostics and returns the explicit
    // synthetic close receipt; no SDK/Native shutdown is claimed by this fixture.
    const client = new DshProtocolClient({
      command: process.execPath,
      args: [
        '-e',
        "require('node:readline').createInterface({input:process.stdin}).on('line',s=>{const f=JSON.parse(s);if(f.method==='shutdown'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result:{allriceClose:{version:1,sdkShutdown:true,rootDisposed:true,priorFramesFlushed:true}}})+'\\n',()=>process.exit(0));}})",
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
