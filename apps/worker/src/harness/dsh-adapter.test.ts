import {
  HarnessEventSchema,
  UserQuestionRequestSchema,
} from '@allrice/contracts';
import { QueueError } from '@allrice/database';
import type * as SubscriptionHome from '../codex-subscription-home.js';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { DshExecutionSnapshot, HarnessEvent } from '@allrice/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HarnessExecutionInput, HarnessToolCall } from './adapter.js';
import { DshRuntimePool, type DshRuntime } from './dsh/runtime-pool.js';
import { DshStartupRejection } from './dsh/startup-rejection.js';
import { HandlerError, confirmToolFailure } from '../errors.js';
import { getDshCleanupFailures } from './dsh-client-cleanup.js';
import { HarnessEventBatcher } from './delta-batcher.js';
import { getAssistantFailureUsage } from './dsh/assistant-outcome.js';
import { assertAssistantProviderOutputBound } from './dsh/assistant-provider.js';
import type { DshRunTimingReport } from './dsh/run-timing.js';
import {
  DshHarnessAdapter,
  normalizeAllRiceManagedFileLinks,
} from './dsh-adapter.js';

const adapters: DshHarnessAdapter[] = [];

afterEach(async () => {
  await Promise.allSettled(
    adapters.splice(0).map((adapter) => adapter.close()),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('normalizeAllRiceManagedFileLinks', () => {
  it('normalizes only authenticated AllRice managed export URLs', () => {
    expect(
      normalizeAllRiceManagedFileLinks(
        '[报告](sandbox:/api/v1/files/file-id/download?token=test)\n' +
          '[DSH 临时文件](sandbox:/tmp/result.md)',
      ),
    ).toBe(
      '[报告](/api/v1/files/file-id/download?token=test)\n' +
        '[DSH 临时文件](sandbox:/tmp/result.md)',
    );
  });
});

function snapshot(
  route: DshExecutionSnapshot['route'] = 'deepseek-official',
): DshExecutionSnapshot {
  return {
    provider: 'dsh',
    authMode: 'allrice_credential',
    route,
    model:
      route === 'deepseek-official' ? 'deepseek-v4-flash' : 'gateway-model',
    reasoningEffort: 'high',
    credentialReference: `test:${route}`,
    baseUrl:
      route === 'openai-compatible' ? 'https://gateway.example/v1' : null,
  };
}

function createAdapter() {
  const adapter = new DshHarnessAdapter({
    credentialResolver: { resolve: async () => ({ apiKey: 'test-secret' }) },
    runtimeCommand: process.execPath,
    runtimeArgs: [
      resolve(import.meta.dirname, 'fixtures/dsh-fake-runtime.mjs'),
    ],
    runtimeRoot: resolve('.local/test-dsh-runtime'),
    cordisConfig: resolve(
      import.meta.dirname,
      '../../dsh/allrice-restricted.cordis.yml',
    ),
    requestTimeoutMs: 5_000,
  });
  adapters.push(adapter);
  return adapter;
}

function executionInput(input: {
  prompt: string;
  provider?: DshExecutionSnapshot;
  threadId?: string | null;
  runtimePackageChecksum?: string;
  signal?: AbortSignal;
  events?: HarnessEvent[];
  onToolCall?: HarnessExecutionInput['onToolCall'];
  images?: HarnessExecutionInput['images'];
  sameSessionAs?: HarnessExecutionInput;
}): HarnessExecutionInput {
  const organizationId =
    input.sameSessionAs?.executionEnvironment.ALLRICE_ORGANIZATION_ID ??
    randomUUID();
  const workspaceId =
    input.sameSessionAs?.executionEnvironment.ALLRICE_WORKSPACE_ID ??
    randomUUID();
  const ownerId =
    input.sameSessionAs?.executionEnvironment.ALLRICE_OWNER_ID ?? randomUUID();
  const events = input.events ?? [];
  return {
    kernel: {
      schemaVersion: 1,
      harness: 'dsh',
      employeeAssignmentId: randomUUID(),
      employeeVersionId: randomUUID(),
      sessionId: input.sameSessionAs?.kernel.sessionId ?? randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      systemInstructions: 'You are Rice.',
      userRequest: input.prompt,
      bootstrapConversation: '',
      authorizedMemoryContext: '',
      grantedCapabilities: ['model:invoke', 'storage:read'],
      skillVersionIds: [],
      runtimePackageChecksum: input.runtimePackageChecksum,
      imageAttachments: [],
    },
    providerSnapshot: input.provider ?? snapshot(),
    storageObjects: [],
    workDirectory: resolve('.local/test-dsh-work'),
    executionEnvironment: {
      ALLRICE_ORGANIZATION_ID: organizationId,
      ALLRICE_WORKSPACE_ID: workspaceId,
      ALLRICE_OWNER_ID: ownerId,
      ALLRICE_RUN_ID: randomUUID(),
      ALLRICE_JOB_ID: randomUUID(),
      ALLRICE_ATTEMPT: '1',
    },
    signal: input.signal ?? new AbortController().signal,
    attempt: 1,
    generation: 0,
    threadId: input.threadId,
    tools: [
      {
        name: 'workspace.file.read',
        description: 'Read one file through the legacy envelope',
        inputSchema: { type: 'object' },
      },
    ],
    images: input.images,
    onToolCall: input.onToolCall,
    onEvent: async (event) => {
      events.push(event);
    },
  };
}

describe('confirmed native dispatch stop receipt', () => {
  function stoppedExecution(close: () => Promise<void>) {
    const adapter = createAdapter();
    const original = Object.freeze(
      new HandlerError('NATIVE_SESSION_ADMISSION_DENIED', 'original', false),
    );
    const input = executionInput({ prompt: 'never prompt a canceled attempt' });
    const prompt = vi.fn();
    const confirmStopped = vi.fn().mockResolvedValue({ completed: true });
    input.questionWait = {
      park: vi.fn(),
      adopted: vi.fn(),
      confirmStopped,
    };
    input.onEvent = async (event) => {
      if (event.sourceEventType === 'allrice/runtime-preparation')
        throw original;
    };
    const runtime = {
      id: randomUUID(),
      sessionId: `dsh-${input.kernel.sessionId}`,
      nativeTools: [],
      client: {
        prompt,
        setRequestHandler: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
    } as unknown as DshRuntime;
    vi.spyOn(
      DshRuntimePool.prototype,
      'hasApprovedNativeLaunch',
    ).mockReturnValue(false);
    vi.spyOn(DshRuntimePool.prototype, 'describeNativeSession').mockReturnValue(
      null,
    );
    vi.spyOn(DshRuntimePool.prototype, 'acquire').mockResolvedValue({
      runtime,
      fresh: false,
      preparation: {
        cache: 'hit',
        reason: 'reused',
        changedFields: [],
        credentialResolutionMs: 0,
        previousRuntimeCloseMs: 0,
        initializeMs: 0,
        skillRegistrationMs: null,
        acquireMs: 0,
      },
    });
    vi.spyOn(DshRuntimePool.prototype, 'touch').mockImplementation(() => {});
    vi.spyOn(DshRuntimePool.prototype, 'clearInputDelivery').mockImplementation(
      () => {},
    );
    const drop = vi
      .spyOn(DshRuntimePool.prototype, 'closeOwned')
      .mockImplementation(close);
    return { adapter, input, original, runtime, prompt, confirmStopped, drop };
  }

  it('waits for the exact close acknowledgement and preserves the original failure', async () => {
    let closed!: () => void;
    const close = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const f = stoppedExecution(() => close);
    const result = f.adapter.execute(f.input).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.drop).toHaveBeenCalledOnce());
    expect(f.drop).toHaveBeenCalledWith(f.runtime);
    expect(f.confirmStopped).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
    closed();
    expect(await result).toBe(f.original);
    expect(f.confirmStopped).toHaveBeenCalledExactlyOnceWith({
      nativeSessionId: f.runtime.sessionId,
      runtimeId: f.runtime.id,
    });
  });

  it('does not fabricate a stop receipt when close is unconfirmed', async () => {
    const unknown = Error('exact child close unconfirmed');
    const f = stoppedExecution(() => Promise.reject(unknown));
    const failure = await f.adapter.execute(f.input).catch((e: unknown) => e);
    expect(failure).toBe(f.original);
    expect(getDshCleanupFailures(failure)).toEqual([unknown]);
    expect(failure).toMatchObject({
      code: 'NATIVE_SESSION_ADMISSION_DENIED',
      retryable: false,
    });
    expect(f.confirmStopped).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it('retains unconfirmed cleanup separately when cancellation wins', async () => {
    const controller = new AbortController();
    const unknown = Error('canceled child close unconfirmed');
    const f = stoppedExecution(async () => {
      controller.abort();
      throw unknown;
    });
    f.input.signal = controller.signal;
    const failure = await f.adapter.execute(f.input).catch((e: unknown) => e);
    expect(failure).toMatchObject({
      code: 'EXECUTION_ABORTED',
      retryable: false,
    });
    expect(getDshCleanupFailures(failure)).toEqual([unknown]);
    expect(failure).toHaveProperty('cause', unknown);
    expect(f.confirmStopped).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.drop).toHaveBeenCalledOnce();
  });

  it('does not retry an unknown/rejected receipt write or replace the original error', async () => {
    const f = stoppedExecution(async () => {});
    f.confirmStopped.mockRejectedValue(Error('commit outcome unknown'));
    expect(await f.adapter.execute(f.input).catch((e: unknown) => e)).toBe(
      f.original,
    );
    expect(f.confirmStopped).toHaveBeenCalledOnce();
    expect(f.drop).toHaveBeenCalledOnce();
  });

  it('keeps callers without the private receipt port unchanged', async () => {
    const f = stoppedExecution(async () => {});
    delete f.input.questionWait!.confirmStopped;
    expect(await f.adapter.execute(f.input).catch((e: unknown) => e)).toBe(
      f.original,
    );
    expect(f.confirmStopped).not.toHaveBeenCalled();
    expect(f.drop).toHaveBeenCalledOnce();
  });
});

/** Actual native Host and its persisted Session; the HTTP peer is synthetic. */
async function schedulingRuntime(
  replies: readonly (
    | string
    | { id: string; wireName?: string; arguments: Record<string, unknown> }
  )[],
  options: {
    beforeFinish?: (requestIndex: number) => Promise<void>;
    usage?: readonly {
      prompt_tokens: number;
      completion_tokens: number;
      prompt_tokens_details: { cached_tokens: number };
    }[];
  } = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), 'allrice-schedule-transport-'));
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const reply =
        replies[requests.length - 1] ?? 'UNEXPECTED_PROVIDER_REQUEST';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: Record<string, unknown>, finish: string | null) =>
        res.write(
          `data: ${JSON.stringify({
            id: `schedule-${requests.length}`,
            object: 'chat.completion.chunk',
            created: 1,
            model: 'schedule-transport',
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(finish && options.usage?.[requests.length - 1]
              ? { usage: options.usage[requests.length - 1] }
              : {}),
          })}\n\n`,
        );
      if (typeof reply === 'string') {
        send({ role: 'assistant', content: reply }, null);
      } else {
        send(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: reply.id,
                type: 'function',
                function: {
                  name: reply.wireName ?? 'automation_create',
                  arguments: JSON.stringify(reply.arguments),
                },
              },
            ],
          },
          null,
        );
      }
      const finish = async () => {
        await options.beforeFinish?.(requests.length - 1);
        if (res.destroyed) return;
        send({}, typeof reply === 'string' ? 'stop' : 'tool_calls');
        res.end('data: [DONE]\n\n');
      };
      void finish().catch((error: unknown) => {
        res.destroy(
          error instanceof Error
            ? error
            : new Error('synthetic response failed'),
        );
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const adapter = new DshHarnessAdapter({
    credentialResolver: { resolve: async () => ({ apiKey: 'synthetic-only' }) },
    runtimeRoot: root,
    requestTimeoutMs: 15_000,
  });
  adapters.push(adapter);
  return {
    adapter,
    root,
    requests,
    provider: {
      ...snapshot('openai-compatible'),
      model: 'schedule-transport',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    },
    close: async () => {
      server.closeAllConnections();
      await adapter.close();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

const schedulingTools: HarnessExecutionInput['tools'] = [
  {
    name: 'automation.create',
    description: 'Create an explicitly requested once or recurring task',
    inputSchema: {
      type: 'object',
      required: ['name', 'prompt'],
      properties: {
        name: { type: 'string' },
        prompt: { type: 'string' },
        delayMinutes: { type: 'integer' },
        rule: {
          oneOf: [
            {
              type: 'object',
              required: ['kind', 'seconds'],
              properties: {
                kind: { const: 'every' },
                seconds: { type: 'integer', minimum: 60 },
              },
            },
            {
              type: 'object',
              required: ['kind', 'time', 'timezone'],
              properties: {
                kind: { const: 'daily' },
                time: { type: 'string' },
                timezone: { type: 'string' },
              },
            },
          ],
        },
      },
    },
  },
];

describe('DshHarnessAdapter', () => {
  it('checks plain completion authority once after the native reply while retaining both dispatch checks and an available tool directory', async () => {
    const diagnostics = vi.spyOn(console, 'info').mockImplementation(() => {});
    const runtime = await schedulingRuntime(['SYNTHETIC_REMINDER']);
    const events: HarnessEvent[] = [];
    const input = executionInput({
      prompt: 'Return a brief synthetic reminder.',
      provider: runtime.provider,
      events,
    });
    input.workDirectory = runtime.root;
    input.tools = schedulingTools;
    const progress = vi.fn(async () => ({ paused: false }));
    input.progress = progress;
    let nativeReplyObserved = false;
    const dispatchChecks: number[] = [],
      completionChecks: number[] = [];
    const append = input.onEvent;
    input.onEvent = async (event) => {
      if (
        event.type === 'assistant.delta' &&
        event.textMode === 'replace' &&
        event.sourceEventType === 'assistant/message'
      )
        nativeReplyObserved = true;
      await append(event);
    };
    input.contentGuard = {
      generationId: randomUUID(),
      check: async () => {
        if (nativeReplyObserved) completionChecks.push(runtime.requests.length);
        else dispatchChecks.push(runtime.requests.length);
      },
    };
    try {
      const result = await runtime.adapter.execute(input);
      expect(result.answer).toBe('SYNTHETIC_REMINDER');
      expect(input.tools).not.toHaveLength(0);
      expect(dispatchChecks).toEqual([0, 0]);
      expect(completionChecks).toEqual([1]);
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'start', kind: 'model' }),
      );
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'finish', kind: 'model' }),
      );
      expect(runtime.requests).toHaveLength(1);
      expect(
        events.filter((event) => event.type === 'tool.started'),
      ).toHaveLength(0);
      expect(
        events.filter((event) => event.type === 'assistant.completed'),
      ).toMatchObject([{ text: 'SYNTHETIC_REMINDER' }]);
      expect(
        events.filter((event) => event.type === 'usage.updated'),
      ).toHaveLength(1);
      const reports = diagnostics.mock.calls
        .filter(([label]) => label === '[AllRice:run-timing]')
        .map(([, report]) => JSON.parse(String(report)) as DshRunTimingReport);
      expect(reports).toHaveLength(1);
      const report = reports[0]!;
      expect(report).toMatchObject({
        event: 'allrice.dsh_run_timing',
        runId: input.executionEnvironment.ALLRICE_RUN_ID,
        sessionId: input.kernel.sessionId,
        outcome: 'completed',
        contentChecks: {
          calls: 3,
          failed: 0,
          pending: 0,
          phases: {
            nativeDispatch: { calls: 1 },
            modelAdmission: { calls: 1 },
            afterNativeResult: { calls: 0 },
            beforeDeliveryValidation: { calls: 0 },
            beforePublication: { calls: 1 },
          },
        },
        modelChain: { calls: 1, completed: 1, unclosed: 0 },
      });
      const points = [
        report.points.preparationCompleted,
        report.points.firstNativeChunk,
        report.points.firstVisibleText,
        report.points.nativeTurnEnded,
        report.points.beforePublication,
        report.points.publicationCompleted,
      ];
      for (const point of points) {
        expect(point).toEqual(expect.any(Number));
        expect(point).toBeGreaterThanOrEqual(0);
        expect(point).toBeLessThanOrEqual(report.elapsedMs);
      }
      expect(points).toEqual([...points].sort((a, b) => a! - b!));
      expect(Object.values(report.capabilities)).toEqual(Array(5).fill(false));
      expect(Object.values(report.wire)).toEqual(Array(4).fill(null));
      expect(JSON.stringify(report)).not.toContain('SYNTHETIC_REMINDER');
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it('records one run report without native model timing and preserves execution when logging fails', async () => {
    const diagnostics = vi.spyOn(console, 'info').mockImplementation(() => {});
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const input = executionInput({ prompt: 'synthetic legacy timing', events });
    const first = await adapter.execute(input);
    const reports = diagnostics.mock.calls
      .filter(([label]) => label === '[AllRice:run-timing]')
      .map(([, report]) => JSON.parse(String(report)) as DshRunTimingReport);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      outcome: 'completed',
      modelChain: { calls: 0, completed: 0 },
      points: {
        firstNativeChunk: expect.any(Number),
        firstVisibleText: expect.any(Number),
        nativeTurnEnded: expect.any(Number),
        publicationCompleted: expect.any(Number),
      },
    });
    expect(
      diagnostics.mock.calls.some(
        ([label]) => label === '[AllRice:model-timing]',
      ),
    ).toBe(false);
    diagnostics.mockImplementation(() => {
      throw Error('synthetic diagnostic sink unavailable');
    });
    const second = await adapter.execute(
      executionInput({
        prompt: 'synthetic legacy timing again',
        events,
        sameSessionAs: input,
        threadId: first.threadId,
      }),
    );
    expect(second.answer).toBe('turn-2');
    expect(
      events.filter((event) => event.type === 'assistant.completed'),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.type === 'usage.updated'),
    ).toHaveLength(2);
    expect(
      diagnostics.mock.calls.filter(
        ([label]) => label === '[AllRice:run-timing]',
      ),
    ).toHaveLength(2);
  });

  it.each(['content_revoked', 'lease_lost'] as const)(
    'does not complete or replay a visible plain reply when %s before provider completion',
    async (failure) => {
      let release!: () => void;
      const finishing = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runtime = await schedulingRuntime(['SYNTHETIC_PARTIAL_REPLY'], {
        beforeFinish: async () => finishing,
      });
      const events: HarnessEvent[] = [];
      const input = executionInput({
        prompt: 'Return a synthetic reply.',
        provider: runtime.provider,
        events,
      });
      input.workDirectory = runtime.root;
      let current = true;
      const denial =
        failure === 'lease_lost'
          ? new QueueError('lease_lost')
          : new HandlerError('EMPLOYEE_CONTENT_UNAVAILABLE', failure, false);
      input.contentGuard = {
        generationId: randomUUID(),
        check: async () => {
          if (!current) throw denial;
        },
      };
      const running = runtime.adapter.execute(input).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await expect
          .poll(
            () =>
              events.some(
                (event) =>
                  event.type === 'assistant.delta' &&
                  event.text.includes('SYNTHETIC_PARTIAL_REPLY'),
              ),
            { timeout: 15_000 },
          )
          .toBe(true);
        expect(
          events.some(
            (event) =>
              event.type === 'assistant.delta' &&
              event.textMode === 'replace' &&
              event.sourceEventType === 'assistant/message',
          ),
        ).toBe(false);
        current = false;
        release();
        const stopped = await running;
        expect(stopped).toMatchObject({
          error: {
            code:
              failure === 'lease_lost'
                ? 'EMPLOYEE_CONTENT_CHECK_UNAVAILABLE'
                : 'EMPLOYEE_CONTENT_UNAVAILABLE',
            retryable: false,
            ...(failure === 'lease_lost'
              ? { cause: denial }
              : { message: failure }),
          },
        });
        expect(runtime.requests).toHaveLength(1);
        expect(
          events.some((event) => event.type === 'assistant.completed'),
        ).toBe(false);
      } finally {
        release();
        await runtime.close();
      }
    },
    30_000,
  );

  it('does not publish completion when cancellation arrives while its final authority check is awaiting', async () => {
    const runtime = await schedulingRuntime(['SYNTHETIC_CANCELED_REPLY']);
    const events: HarnessEvent[] = [];
    const controller = new AbortController();
    const input = executionInput({
      prompt: 'Return a synthetic reply.',
      provider: runtime.provider,
      events,
      signal: controller.signal,
    });
    input.workDirectory = runtime.root;
    let nativeReplyObserved = false,
      finalCheckAwaiting = false;
    let release!: () => void;
    const checking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = input.onEvent;
    input.onEvent = async (event) => {
      if (
        event.type === 'assistant.delta' &&
        event.textMode === 'replace' &&
        event.sourceEventType === 'assistant/message'
      )
        nativeReplyObserved = true;
      await append(event);
    };
    input.contentGuard = {
      generationId: randomUUID(),
      check: async () => {
        if (nativeReplyObserved) {
          finalCheckAwaiting = true;
          await checking;
        }
      },
    };
    const running = runtime.adapter.execute(input).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await expect
        .poll(() => finalCheckAwaiting, { timeout: 15_000 })
        .toBe(true);
      controller.abort();
      release();
      expect(await running).toHaveProperty('error');
      expect(runtime.requests).toHaveLength(1);
      expect(events.some((event) => event.type === 'assistant.completed')).toBe(
        false,
      );
    } finally {
      controller.abort();
      release();
      await runtime.close();
    }
  }, 30_000);

  it.each(['Broker envelope', 'native function'] as const)(
    'retains completion authority barriers after a %s tool has executed',
    async (transport) => {
      const native = transport === 'native function';
      const call: HarnessToolCall = {
        id: randomUUID(),
        name: native ? 'local.fs.list' : 'automation.create',
        arguments: native
          ? { path: '.', limit: 20 }
          : {
              name: 'synthetic task',
              prompt: 'Synthetic reminder',
              delayMinutes: 2,
            },
      };
      const runtime = await schedulingRuntime([
        native
          ? {
              id: call.id,
              wireName: 'local_fs_list',
              arguments: call.arguments,
            }
          : `<allrice_tool_call>${JSON.stringify(call)}</allrice_tool_call>`,
        'SYNTHETIC_TOOL_RECEIPT_OBSERVED',
      ]);
      const events: HarnessEvent[] = [];
      const onToolCall = vi.fn(async () => ({
        modelContent: '{"syntheticReceipt":true}',
        summary: 'synthetic receipt',
      }));
      const input = executionInput({
        prompt: native
          ? 'List a synthetic directory.'
          : 'Set one synthetic reminder.',
        provider: runtime.provider,
        events,
        onToolCall,
      });
      input.workDirectory = runtime.root;
      input.tools = native
        ? [
            {
              name: 'local.fs.list',
              description: 'List files through the synthetic Broker',
              inputSchema: { type: 'object' },
            },
          ]
        : schedulingTools;
      const onTurnStarted = vi.fn(async () => {});
      input.onTurnStarted = onTurnStarted;
      let nativeReplyObserved = false;
      const completionChecks: number[] = [];
      const append = input.onEvent;
      input.onEvent = async (event) => {
        if (
          event.type === 'assistant.delta' &&
          event.textMode === 'replace' &&
          event.sourceEventType === 'assistant/message'
        )
          nativeReplyObserved = true;
        await append(event);
      };
      input.contentGuard = {
        generationId: randomUUID(),
        check: async () => {
          if (nativeReplyObserved)
            completionChecks.push(runtime.requests.length);
        },
      };
      try {
        const result = await runtime.adapter.execute(input);
        expect(result.answer).toBe('SYNTHETIC_TOOL_RECEIPT_OBSERVED');
        expect(onToolCall).toHaveBeenCalledExactlyOnceWith(call);
        expect(onTurnStarted).toHaveBeenCalledTimes(native ? 1 : 2);
        expect(runtime.requests).toHaveLength(2);
        expect(completionChecks).toEqual([2, 2, 2]);
        expect(
          events.filter((event) => event.type === 'tool.completed'),
        ).toMatchObject([
          { name: call.name, source: native ? 'harness' : 'tool_broker' },
        ]);
        expect(
          events.filter((event) => event.type === 'assistant.completed'),
        ).toHaveLength(1);
      } finally {
        await runtime.close();
      }
    },
    30_000,
  );

  it('rechecks current authority after the final-delivery callback waits', async () => {
    const runtime = await schedulingRuntime(['SYNTHETIC_CHECKED_REPLY']);
    const events: HarnessEvent[] = [];
    const input = executionInput({
      prompt: 'Return a synthetic reply.',
      provider: runtime.provider,
      events,
    });
    input.workDirectory = runtime.root;
    let current = true,
      deliveryAwaiting = false;
    let release!: () => void;
    const checking = new Promise<void>((resolve) => {
      release = resolve;
    });
    input.contentGuard = {
      generationId: randomUUID(),
      check: async () => {
        if (!current)
          throw new HandlerError(
            'EMPLOYEE_CONTENT_UNAVAILABLE',
            'revoked during final delivery',
            false,
          );
      },
    };
    const deliveryCheck = vi.fn(
      async (candidate: { projectedText: string }) => {
        deliveryAwaiting = true;
        await checking;
        return {
          status: 'valid' as const,
          candidateDigest:
            'sha256:' +
            createHash('sha256').update(candidate.projectedText).digest('hex'),
          factSetDigest: 'sha256:' + 'a'.repeat(64),
          issues: [],
          linked: [],
          textRepairEligible: false,
        };
      },
    );
    input.finalDelivery = { check: deliveryCheck };
    const running = runtime.adapter.execute(input).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await expect.poll(() => deliveryAwaiting, { timeout: 15_000 }).toBe(true);
      current = false;
      release();
      expect(await running).toMatchObject({
        error: { code: 'EMPLOYEE_CONTENT_UNAVAILABLE', retryable: false },
      });
      expect(deliveryCheck).toHaveBeenCalledTimes(1);
      expect(runtime.requests).toHaveLength(1);
      expect(events.some((event) => event.type === 'assistant.completed')).toBe(
        false,
      );
    } finally {
      release();
      await runtime.close();
    }
  }, 30_000);

  it.each([
    {
      prompt: '请每隔两分钟提醒我喝水。',
      rule: { kind: 'every', seconds: 120 },
    },
    { prompt: '1 分钟尖叫一次', rule: { kind: 'every', seconds: 60 } },
    {
      prompt: '请每天09:30，时区Asia/Shanghai，提醒我检查报表。',
      rule: { kind: 'daily', time: '09:30:00', timezone: 'Asia/Shanghai' },
    },
  ])(
    'roundtrips an explicit $rule.kind request through the real Host and canonical Broker envelope',
    async ({ prompt, rule }) => {
      const id = randomUUID();
      const args = { name: '周期校验', prompt, rule };
      const call = { id, name: 'automation.create', arguments: args };
      const receipt = JSON.stringify({ syntheticTaskId: randomUUID(), rule });
      const runtime = await schedulingRuntime([
        `<allrice_tool_call>${JSON.stringify(call)}</allrice_tool_call>`,
        'SYNTHETIC_RECURRING_RECEIPT_OBSERVED',
      ]);
      const events: HarnessEvent[] = [];
      const onToolCall = vi.fn(async () => ({
        modelContent: receipt,
        summary: 'synthetic receipt',
      }));
      const input = executionInput({
        prompt,
        provider: runtime.provider,
        events,
        onToolCall,
      });
      input.currentUserRequest = prompt;
      input.workDirectory = runtime.root;
      input.tools = schedulingTools;
      try {
        const result = await runtime.adapter.execute(input);
        expect(onToolCall).toHaveBeenCalledExactlyOnceWith(call);
        expect(runtime.requests).toHaveLength(2);
        expect(JSON.stringify(runtime.requests[0]?.tools ?? [])).not.toContain(
          'automation_create',
        );
        expect(JSON.stringify(runtime.requests[0]?.messages)).toContain(
          'automation.create',
        );
        expect(JSON.stringify(runtime.requests[1]?.messages)).toContain(
          JSON.parse(receipt).syntheticTaskId,
        );
        expect(result.answer).toBe('SYNTHETIC_RECURRING_RECEIPT_OBSERVED');
        expect(
          runtime.adapter.runtimeInventory()[0]?.nativeTools,
        ).not.toContain('automation.create');
        expect(
          events.filter((event) => event.type === 'tool.completed'),
        ).toEqual([
          expect.objectContaining({
            name: 'automation.create',
            toolCallId: id,
            source: 'tool_broker',
          }),
        ]);
        expect(
          JSON.stringify(
            events.filter(
              (event) =>
                event.type === 'assistant.delta' ||
                event.type === 'assistant.completed',
            ),
          ),
        ).not.toContain('allrice_tool_call');
      } finally {
        await runtime.close();
      }
    },
    30_000,
  );

  it('returns a confirmed scheduling rejection to the native loop and closes its failed tool outcome', async () => {
    const prompt = '请每隔两分钟提醒我喝水。';
    const call = {
      id: randomUUID(),
      name: 'automation.create',
      arguments: {
        name: '周期校验',
        prompt,
        rule: { kind: 'every', seconds: 120 },
      },
    };
    const answer = '尚未创建任务，请补充缺失信息。';
    const runtime = await schedulingRuntime(
      [
        `<allrice_tool_call>${JSON.stringify(call)}</allrice_tool_call>`,
        answer,
      ],
      {
        usage: [
          {
            prompt_tokens: 100,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 20 },
          },
          {
            prompt_tokens: 120,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 30 },
          },
        ],
      },
    );
    const failure = new HandlerError(
      'AUTOMATION_REQUEST_UNCLEAR',
      '未创建任务，需要明确的工作。',
      false,
    );
    const progress = vi.fn().mockResolvedValue({});
    const events: HarnessEvent[] = [];
    const onToolCall = vi.fn(async () => {
      throw failure;
    });
    const input = executionInput({
      prompt,
      provider: runtime.provider,
      events,
      onToolCall,
    });
    confirmToolFailure(failure, {
      runId: input.executionEnvironment.ALLRICE_RUN_ID!,
      callId: call.id,
      toolName: call.name,
    });
    input.currentUserRequest = prompt;
    input.workDirectory = runtime.root;
    input.tools = schedulingTools;
    input.progress = progress;
    try {
      const result = await runtime.adapter.execute(input);
      expect(result.answer).toBe(answer);
      expect(result.usageComplete).toBe(true);
      // This actual OpenAI-compatible adapter reports read cache but no write
      // cache receipt; missing cache detail must remain unknown, not zero.
      expect(result.cacheUsageKnown).toBe(false);
      expect(result.usage).toEqual({
        inputTokens: 170,
        cachedInputTokens: 50,
        outputTokens: 9,
      });
      expect(onToolCall).toHaveBeenCalledExactlyOnceWith(call);
      expect(runtime.requests).toHaveLength(2);
      const continuation = JSON.stringify(runtime.requests[1]);
      expect(continuation).toContain('AUTOMATION_REQUEST_UNCLEAR');
      expect(continuation).toContain('confirmed failure receipt');
      expect(continuation).toContain('outcome-unknown writes');
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'finish',
          kind: 'tool',
          callId: call.id,
          outcome: 'error',
          resultDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        }),
      );
      expect(
        events.filter((event) => event.type === 'tool.failed'),
      ).toHaveLength(1);
      expect(events.some((event) => event.type === 'tool.completed')).toBe(
        false,
      );
      expect(
        events.filter((event) => event.type === 'assistant.completed'),
      ).toEqual([expect.objectContaining({ text: answer })]);
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it('does not dispatch another native turn when cancellation arrives during failed tool settlement', async () => {
    const prompt = '请每隔两分钟提醒我喝水。';
    const call = {
      id: randomUUID(),
      name: 'automation.create',
      arguments: {
        name: '周期校验',
        prompt,
        rule: { kind: 'every', seconds: 120 },
      },
    };
    const runtime = await schedulingRuntime([
      `<allrice_tool_call>${JSON.stringify(call)}</allrice_tool_call>`,
      'MUST_NOT_RUN',
    ]);
    const controller = new AbortController();
    const failure = new HandlerError(
      'AUTOMATION_REQUEST_UNCLEAR',
      '未创建任务',
      false,
    );
    const input = executionInput({
      prompt,
      provider: runtime.provider,
      signal: controller.signal,
      onToolCall: async () => {
        throw failure;
      },
    });
    confirmToolFailure(failure, {
      runId: input.executionEnvironment.ALLRICE_RUN_ID!,
      callId: call.id,
      toolName: call.name,
    });
    input.workDirectory = runtime.root;
    input.tools = schedulingTools;
    let settlementEntered = false;
    let release!: () => void;
    const settling = new Promise<void>((resolve) => {
      release = resolve;
    });
    input.progress = async (value) => {
      if (value.action === 'finish' && value.kind === 'tool') {
        settlementEntered = true;
        await settling;
      }
      return {};
    };
    const execution = runtime.adapter
      .execute(input)
      .catch((error: unknown) => error);
    try {
      await expect
        .poll(() => settlementEntered, { timeout: 15_000 })
        .toBe(true);
      controller.abort();
      release();
      expect(await execution).toMatchObject({ code: 'EXECUTION_ABORTED' });
      expect(runtime.requests).toHaveLength(1);
    } finally {
      controller.abort();
      release();
      await execution;
      await runtime.close();
    }
  }, 30_000);

  it('stops on an unknown recurring Broker result without another provider turn or write', async () => {
    const prompt = '请每隔两分钟提醒我喝水。';
    const call = {
      id: randomUUID(),
      name: 'automation.create',
      arguments: {
        name: '周期校验',
        prompt,
        rule: { kind: 'every', seconds: 120 },
      },
    };
    const runtime = await schedulingRuntime([
      `<allrice_tool_call>${JSON.stringify(call)}</allrice_tool_call>`,
    ]);
    const events: HarnessEvent[] = [];
    const unknown = Error('synthetic commit acknowledgement lost');
    const onToolCall = vi.fn(async () => {
      throw unknown;
    });
    const input = executionInput({
      prompt,
      provider: runtime.provider,
      events,
      onToolCall,
    });
    input.currentUserRequest = prompt;
    input.workDirectory = runtime.root;
    input.tools = schedulingTools;
    try {
      await expect(runtime.adapter.execute(input)).rejects.toBe(unknown);
      expect(onToolCall).toHaveBeenCalledExactlyOnceWith(call);
      expect(runtime.requests).toHaveLength(1);
      expect(events.filter((event) => event.type === 'tool.failed')).toEqual([
        expect.objectContaining({
          name: 'automation.create',
          toolCallId: call.id,
        }),
      ]);
      expect(
        events.some(
          (event) =>
            event.type === 'tool.completed' ||
            event.type === 'assistant.completed',
        ),
      ).toBe(false);
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it('recovers the same persisted Session across once → recurring → once with the complete stable host tool schema', async () => {
    const oncePrompt = '请在15分钟后提醒我喝水。';
    const recurringPrompt = '请每隔两分钟提醒我喝水。';
    const onceArgs = { name: '一次校验', prompt: oncePrompt, delayMinutes: 15 };
    const recurringArgs = {
      name: '周期校验',
      prompt: recurringPrompt,
      rule: { kind: 'every', seconds: 120 },
    };
    const envelopeId = randomUUID();
    const runtime = await schedulingRuntime([
      `<allrice_tool_call>${JSON.stringify({ id: randomUUID(), name: 'automation.create', arguments: onceArgs })}</allrice_tool_call>`,
      'FIRST_ONCE_RECEIPT',
      `<allrice_tool_call>${JSON.stringify({ id: envelopeId, name: 'automation.create', arguments: recurringArgs })}</allrice_tool_call>`,
      'RECURRING_RECEIPT',
      `<allrice_tool_call>${JSON.stringify({ id: randomUUID(), name: 'automation.create', arguments: onceArgs })}</allrice_tool_call>`,
      'SECOND_ONCE_RECEIPT',
    ]);
    const onToolCall = vi.fn(async (call: HarnessToolCall) => ({
      modelContent: 'synthetic durable receipt',
      summary: call.name,
    }));
    const first = executionInput({
      prompt: oncePrompt,
      provider: runtime.provider,
      onToolCall,
    });
    first.currentUserRequest = oncePrompt;
    first.workDirectory = runtime.root;
    first.tools = schedulingTools;
    try {
      const onceResult = await runtime.adapter.execute(first);
      const onceProcess = runtime.adapter.runtimeInventory()[0]!;
      const second = executionInput({
        prompt: recurringPrompt,
        provider: runtime.provider,
        onToolCall,
        sameSessionAs: first,
        threadId: onceResult.threadId,
      });
      second.currentUserRequest = recurringPrompt;
      second.workDirectory = runtime.root;
      second.tools = schedulingTools;
      const recurringResult = await runtime.adapter.execute(second);
      const recurringProcess = runtime.adapter.runtimeInventory()[0]!;
      const third = executionInput({
        prompt: oncePrompt,
        provider: runtime.provider,
        onToolCall,
        sameSessionAs: first,
        threadId: recurringResult.threadId,
      });
      third.currentUserRequest = oncePrompt;
      third.workDirectory = runtime.root;
      third.tools = schedulingTools;
      const restoredResult = await runtime.adapter.execute(third);
      const restoredProcess = runtime.adapter.runtimeInventory()[0]!;
      expect([
        onceResult.answer,
        recurringResult.answer,
        restoredResult.answer,
      ]).toEqual([
        'FIRST_ONCE_RECEIPT',
        'RECURRING_RECEIPT',
        'SECOND_ONCE_RECEIPT',
      ]);
      expect(recurringResult.threadId).toBe(onceResult.threadId);
      expect(restoredResult.threadId).toBe(onceResult.threadId);
      expect([
        onceProcess.nativeTools,
        recurringProcess.nativeTools,
        restoredProcess.nativeTools,
      ]).toEqual([[], [], []]);
      expect(
        new Set([onceProcess.id, recurringProcess.id, restoredProcess.id]).size,
      ).toBe(1);
      expect(runtime.requests).toHaveLength(6);
      expect(JSON.stringify(runtime.requests[0]?.tools ?? [])).not.toContain(
        'automation_create',
      );
      expect(JSON.stringify(runtime.requests[2]?.tools ?? [])).not.toContain(
        'automation_create',
      );
      expect(JSON.stringify(runtime.requests[4]?.tools ?? [])).not.toContain(
        'automation_create',
      );
      expect(JSON.stringify(runtime.requests[2]?.messages)).toContain(
        'FIRST_ONCE_RECEIPT',
      );
      expect(JSON.stringify(runtime.requests[4]?.messages)).toContain(
        'RECURRING_RECEIPT',
      );
      expect(onToolCall.mock.calls.map(([call]) => call)).toEqual([
        expect.objectContaining({
          name: 'automation.create',
          arguments: onceArgs,
        }),
        { id: envelopeId, name: 'automation.create', arguments: recurringArgs },
        expect.objectContaining({
          name: 'automation.create',
          arguments: onceArgs,
        }),
      ]);
    } finally {
      await runtime.close();
    }
  }, 45_000);

  it('bounds a long native question event summary while preserving its exact confirmation payload', async () => {
    const events: HarnessEvent[] = [];
    await createAdapter().execute(
      executionInput({ prompt: 'long-method-confirmation-question', events }),
    );
    const event = events.find(
      (e) =>
        e.type === 'native.event' &&
        e.sourceEventType === 'session/user-question',
    );
    expect(event).toBeDefined();
    expect(HarnessEventSchema.safeParse(event).success).toBe(true);
    if (event?.type !== 'native.event') throw Error('missing question');
    expect(event.summary!.length).toBeLessThanOrEqual(1000);
    const request = UserQuestionRequestSchema.parse(event.sourcePayload);
    expect(request.questions[0]!.question).toBe('完整确认内容'.repeat(300));
  });
  it('uses a new native persisted thread after revocation and preserves a denied guard across RPC errors', async () => {
    const root = await mkdtemp(
      resolve(tmpdir(), 'allrice-content-generation-'),
    );
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (delta: Record<string, unknown>, finish: string | null) =>
          res.write(
            `data: ${JSON.stringify({ id: 'content-check', object: 'chat.completion.chunk', created: 1, model: 'content-check', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          );
        send(
          {
            role: 'assistant',
            content:
              requests.length === 1
                ? 'OLD_DERIVED_ANSWER_42'
                : 'CURRENT_ANSWER_73',
          },
          null,
        );
        send({}, 'stop');
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const makeAdapter = () => {
      const adapter = new DshHarnessAdapter({
        credentialResolver: {
          resolve: async () => ({ apiKey: 'synthetic-only' }),
        },
        runtimeRoot: root,
        requestTimeoutMs: 15_000,
      });
      adapters.push(adapter);
      return adapter;
    };
    let adapter = makeAdapter();
    const input = executionInput({
      prompt: 'OLD_PRIVATE_REQUEST_42',
      provider: {
        ...snapshot('openai-compatible'),
        model: 'content-check',
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      },
    });
    input.workDirectory = root;
    input.tools = [];
    input.kernel.systemInstructions = 'OLD_COMMON_REQUIREMENT_42';
    input.contentGuard = { generationId: randomUUID(), check: async () => {} };
    try {
      const first = await adapter.execute(input);
      expect(first.threadId).toBe(
        `dsh-${input.kernel.sessionId}-${input.contentGuard.generationId}`,
      );
      expect(requests).toHaveLength(1);
      await adapter.close();
      adapter = makeAdapter(); // Same on-disk DSH root, new Worker process.
      input.threadId = first.threadId; // Deliberately supply the stale runtime record.
      input.contentGuard = {
        generationId: randomUUID(),
        check: async () => {},
      };
      input.kernel.systemInstructions = 'CURRENT_COMMON_REQUIREMENT_73';
      input.kernel.userRequest = 'CURRENT_REQUEST_73';
      input.kernel.userMessageId = randomUUID();
      input.kernel.assistantMessageId = randomUUID();
      const second = await adapter.execute(input);
      expect(second.threadId).not.toBe(first.threadId);
      expect(requests).toHaveLength(2);
      const sent = JSON.stringify(requests[1]);
      expect(sent).toContain('CURRENT_COMMON_REQUIREMENT_73');
      expect(sent).toContain('CURRENT_REQUEST_73');
      expect(sent).not.toContain('OLD_COMMON_REQUIREMENT_42');
      expect(sent).not.toContain('OLD_PRIVATE_REQUEST_42');
      expect(sent).not.toContain('OLD_DERIVED_ANSWER_42');
      input.threadId = second.threadId;
      input.contentGuard.check = async () => {
        throw new HandlerError(
          'EMPLOYEE_CONTENT_UNAVAILABLE',
          'revoked',
          false,
        );
      };
      await expect(adapter.execute(input)).rejects.toMatchObject({
        code: 'EMPLOYEE_CONTENT_UNAVAILABLE',
        retryable: false,
      });
      expect(requests).toHaveLength(2); // No provider retry or plaintext fallback.
      const databaseError = Object.assign(new Error('deadlock detected'), {
        code: '40P01',
      });
      input.contentGuard.check = async () => {
        throw databaseError;
      };
      const failure = await adapter
        .execute(input)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'EMPLOYEE_CONTENT_CHECK_UNAVAILABLE',
        retryable: false,
        cause: databaseError,
      });
      expect((failure as Error).cause).toBe(databaseError);
      expect(requests).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await adapter.close();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it.each(['complete', 'cancel'] as const)(
    'streams through the actual pinned native process and batcher before provider completion (%s)',
    async (outcome) => {
      const root = await mkdtemp(resolve(tmpdir(), 'allrice-live-stream-'));
      const responses: ServerResponse[] = [];
      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.flushHeaders();
          responses.push(res);
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as { port: number }).port;
      const adapter = new DshHarnessAdapter({
        credentialResolver: {
          resolve: async () => ({ apiKey: 'synthetic-only' }),
        },
        runtimeRoot: root,
        requestTimeoutMs: 15_000,
      });
      adapters.push(adapter);
      const events: HarnessEvent[] = [];
      const batcher = new HarnessEventBatcher(async (event) => {
        events.push(event);
      });
      const controller = new AbortController();
      const input = executionInput({
        prompt: 'Reply using the synthetic stream.',
        provider: {
          ...snapshot('openai-compatible'),
          model: 'native-stream-contract',
          baseUrl: `http://127.0.0.1:${port}/v1`,
        },
        signal: controller.signal,
      });
      input.workDirectory = root;
      input.tools = [];
      input.onEvent = (event) => batcher.accept(event);
      const appendText = () =>
        events
          .filter(
            (e): e is Extract<HarnessEvent, { type: 'assistant.delta' }> =>
              e.type === 'assistant.delta' && e.textMode !== 'replace',
          )
          .map((e) => e.text)
          .join('');
      const send = (
        res: ServerResponse,
        delta: Record<string, unknown>,
        finish: string | null = null,
      ) =>
        res.write(
          `data: ${JSON.stringify({ id: 'native-stream', object: 'chat.completion.chunk', created: 1, model: 'native-stream-contract', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      let settled = false;
      const running = adapter.execute(input).then(
        (result) => {
          settled = true;
          return { result };
        },
        (error) => {
          settled = true;
          return { error };
        },
      );
      try {
        await expect.poll(() => responses.length, { timeout: 15_000 }).toBe(1);
        send(responses[0]!, {
          role: 'assistant',
          reasoning_content: 'private model reasoning',
        });
        send(responses[0]!, { content: 'First paragraph. ' });
        await expect
          .poll(appendText, { timeout: 5000 })
          .toBe('First paragraph. ');
        expect(settled).toBe(false);
        send(responses[0]!, { content: 'Second paragraph.' });
        await expect
          .poll(appendText, { timeout: 5000 })
          .toBe('First paragraph. Second paragraph.');
        expect(settled).toBe(false);
        expect(
          events.filter(
            (e) => e.type === 'assistant.delta' && e.textMode !== 'replace',
          ).length,
        ).toBeGreaterThanOrEqual(2);
        expect(
          events.some((e) => e.sourceEventType === 'assistant/live-chunk'),
        ).toBe(true);
        expect(JSON.stringify(events)).not.toContain('private model reasoning');
        if (outcome === 'cancel') {
          controller.abort();
          const canceled = await running;
          expect(canceled).toHaveProperty('error');
          await batcher.close();
          const count = events.length;
          send(responses[0]!, {
            content: 'must not append after cancellation',
          });
          responses[0]!.end();
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(events.length).toBe(count);
          expect(events.some((e) => e.type === 'assistant.completed')).toBe(
            false,
          );
          return;
        }
        send(responses[0]!, {}, 'stop');
        responses[0]!.end('data: [DONE]\n\n');
        const first = await running;
        expect(first).not.toHaveProperty('error');
        await batcher.close();
        expect(
          events.filter((e) => e.type === 'assistant.completed'),
        ).toMatchObject([{ text: 'First paragraph. Second paragraph.' }]);
        expect(
          events.filter(
            (e) => e.type === 'assistant.delta' && e.textMode === 'replace',
          ),
        ).toMatchObject([{ text: 'First paragraph. Second paragraph.' }]);
        // Reuse the live Agent: its frame revision is already nonzero.
        input.threadId = 'result' in first ? first.result.threadId : undefined;
        input.kernel.userMessageId = randomUUID();
        input.kernel.assistantMessageId = randomUUID();
        events.length = 0;
        const continued = adapter.execute(input).then(
          (result) => ({ result }),
          (error) => ({ error }),
        );
        await expect.poll(() => responses.length, { timeout: 15_000 }).toBe(2);
        send(responses[1]!, { role: 'assistant', content: 'Continuation.' });
        await expect.poll(appendText, { timeout: 5000 }).toBe('Continuation.');
        send(responses[1]!, {}, 'stop');
        responses[1]!.end('data: [DONE]\n\n');
        expect(await continued).not.toHaveProperty('error');
      } finally {
        controller.abort();
        for (const res of responses) res.destroy();
        server.closeAllConnections();
        await adapter.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await batcher.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    45_000,
  );
  it.each(['TRANSPORT', 'TIMEOUT', 'SERVER', 'PI_AI_ERROR', 'AUTH'])(
    'keeps terminal native %s failure without retrying the whole prompt',
    async (code) => {
      const events: HarnessEvent[] = [];
      const adapter = createAdapter();
      await expect(
        adapter.execute(
          executionInput({
            prompt: `terminal-model-error:${code}`,
            events,
          }),
        ),
      ).rejects.toMatchObject({ code: `DSH_${code}`, retryable: false });
      expect(
        events.filter((event) => event.type === 'tool.completed'),
      ).toHaveLength(1);
      expect(events.some((event) => event.type === 'assistant.completed')).toBe(
        false,
      );
      expect(adapter.runtimeInventory()).toEqual([]);
    },
  );

  it.each([
    ['dns', '网页地址解析异常，未能确认公开网络地址。'],
    ['assistant', '没有可接收消息的助手，当前任务可直接继续。'],
  ])(
    'shows a fixed %s failure summary without raw provider contents',
    async (cause, summary) => {
      const events: HarnessEvent[] = [];
      await createAdapter().execute(
        executionInput({ prompt: `native-result-outcome:${cause}`, events }),
      );
      expect(
        events.find((event) => event.type === 'tool.failed'),
      ).toMatchObject({ summary });
      expect(JSON.stringify(events)).not.toContain('secret-token');
    },
  );

  it('forwards model wait lifecycle only from this session with valid statuses', async () => {
    const events: HarnessEvent[] = [];
    await createAdapter().execute(
      executionInput({ prompt: 'model-wait-progress', events }),
    );
    const waiting = events.filter(
      (event) =>
        event.type === 'native.event' &&
        event.sourceEventType === 'allrice/model-wait',
    );
    expect(waiting).toMatchObject([
      {
        type: 'native.event',
        label: '等待模型响应',
        presentation: 'lifecycle',
        status: 'started',
      },
      {
        type: 'native.event',
        label: '等待模型响应',
        presentation: 'lifecycle',
        status: 'completed',
      },
    ]);
    expect(waiting).toHaveLength(2);
  });

  it('clears retired live attempts in place and ignores duplicates and late chunks', async () => {
    const events: HarnessEvent[] = [];
    const result = await createAdapter().execute(
      executionInput({ prompt: 'live-attempt-retirement', events }),
    );
    expect(result.answer).toBe('最终回复');
    const deltas = events.filter((e) => e.type === 'assistant.delta');
    expect(deltas.map((e) => [e.textMode ?? 'append', e.text])).toEqual([
      ['append', '失败的半段'],
      ['replace', ''],
      ['append', '已放弃的半段'],
      ['replace', ''],
      ['append', '最终回复'],
      ['replace', '最终回复'],
    ]);
    expect(new Set(deltas.map((e) => e.replyId)).size).toBe(1);
    expect(events.filter((e) => e.type === 'assistant.completed')).toHaveLength(
      1,
    );
  });

  it('preserves native message boundaries, retry replacements and message-only replies before tools', async () => {
    const events: HarnessEvent[] = [];
    const result = await createAdapter().execute(
      executionInput({ prompt: 'interleaved-progress', events }),
    );
    expect(result.answer).toBe('最终总结');
    const visible = events.filter((e) => e.type === 'assistant.delta');
    const replies = new Map<string, string>();
    for (const e of visible)
      replies.set(
        e.replyId!,
        e.textMode === 'replace'
          ? e.text
          : (replies.get(e.replyId!) ?? '') + e.text,
      );
    expect([...replies.values()]).toEqual([
      '先检查目录',
      '确认入口文件',
      '最终总结',
    ]);
    expect(new Set(visible.map((e) => e.replyId)).size).toBe(3);
    expect(visible.some((e) => e.textMode === 'replace' && e.text === '')).toBe(
      true,
    );
    const textBeforeTool = events.findIndex(
      (e) => e.type === 'assistant.delta' && e.text === '先检查目录',
    );
    const tool = events.findIndex((e) => e.type === 'tool.started');
    const report = events.findIndex(
      (e) => e.type === 'assistant.delta' && e.text === '确认入口文件',
    );
    expect(textBeforeTool).toBeLessThan(tool);
    expect(tool).toBeLessThan(report);
    expect(JSON.stringify(events)).not.toContain('private reasoning');
  });

  it('settles an acknowledged turn when its process dies, preserving output without retrying', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const input = executionInput({
      prompt: 'crash after acknowledgement',
      events,
    });
    const error = await adapter.execute(input).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'DSH_EXECUTION_OUTCOME_UNKNOWN',
      retryable: false,
    });
    expect(getDshCleanupFailures(error)).toHaveLength(1);
    expect(getDshCleanupFailures(error)[0]).toMatchObject({
      code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
      retryable: false,
      evidence: {
        process: {
          state: 'exited',
          stdioClosed: true,
          exitCode: null,
          signal: 'SIGKILL',
        },
        shutdownAcknowledged: false,
        wrapperCleanupConfirmed: false,
      },
    });
    expect(error).toHaveProperty('cause', getDshCleanupFailures(error)[0]);
    expect(adapter.runtimeClosureInventory()).toMatchObject([
      {
        state: 'unconfirmed',
        processState: 'exited',
        stdioClosed: true,
        wrapperCleanupConfirmed: false,
      },
    ]);
    expect(
      events.some(
        (e) =>
          e.type === 'assistant.delta' && e.text === 'retained partial output',
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === 'assistant.completed')).toBe(false);
    expect(adapter.runtimeInventory()).toEqual([]);
    expect(
      getAssistantFailureUsage(
        error,
        input.executionEnvironment.ALLRICE_RUN_ID!,
        input.attempt,
      ),
    ).toEqual({
      usage: { inputTokens: 11, cachedInputTokens: 3, outputTokens: 5 },
      usageComplete: false,
      cacheUsageKnown: false,
    });
  }, 5000);

  it.each([
    { fresh: true, matchingRoot: true, known: true },
    { fresh: false, matchingRoot: true, known: false },
    { fresh: true, matchingRoot: false, known: false },
  ])(
    'bind rejection proves only fresh matching startup: $fresh/$matchingRoot',
    async ({ fresh, matchingRoot, known }) => {
      const adapter = createAdapter();
      const input = executionInput({
        prompt: 'never dispatch',
        provider: snapshot('openai-compatible'),
      });
      const original = new HandlerError('TEST_BIND_REJECTED', 'denied', false);
      const prompt = vi.fn();
      const nativeAssistant = vi.fn();
      const runtime = {
        client: { prompt, assistant: nativeAssistant },
      } as unknown as DshRuntime;
      vi.spyOn(DshRuntimePool.prototype, 'acquire').mockResolvedValue({
        runtime,
        fresh,
        preparation: {
          cache: fresh ? 'miss' : 'hit',
          reason: fresh ? 'not_resident' : 'reused',
          changedFields: [],
          credentialResolutionMs: 0,
          previousRuntimeCloseMs: 0,
          initializeMs: 0,
          skillRegistrationMs: null,
          acquireMs: 0,
        },
      });
      const drop = vi
        .spyOn(DshRuntimePool.prototype, 'drop')
        .mockResolvedValue();
      input.assistants = {
        deliveryMode: 'legacy',
        rootRunId: matchingRoot
          ? input.executionEnvironment.ALLRICE_RUN_ID!
          : randomUUID(),
        bind: vi.fn(async () => {
          throw original;
        }),
      };
      const error = await adapter
        .execute(input)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: 'TEST_BIND_REJECTED',
        retryable: false,
      });
      expect(error instanceof DshStartupRejection).toBe(known);
      if (error instanceof DshStartupRejection) {
        expect(error.cause).toBe(original);
        expect(
          error.belongsTo(input.executionEnvironment.ALLRICE_RUN_ID!, 1),
        ).toBe(true);
        expect(error.belongsTo(randomUUID(), 1)).toBe(false);
        expect(
          error.belongsTo(input.executionEnvironment.ALLRICE_RUN_ID!, 2),
        ).toBe(false);
        expect(
          JSON.parse(JSON.stringify(error)) instanceof DshStartupRejection,
        ).toBe(false);
      } else expect(error).toBe(original);
      expect(drop).toHaveBeenCalledOnce();
      expect(prompt).not.toHaveBeenCalled();
      expect(nativeAssistant).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['usage-complete', true, true, 16, 5],
    ['usage-missing', false, false, 0, 0],
    ['usage-synthetic-zero', false, false, 0, 0],
    ['usage-zero-after-delta', false, false, 11, 0],
    ['multi-receipts-complete', true, true, 32, 10],
    ['multi-receipts-missing-then-complete', false, false, 16, 5],
    ['ordinary-missing-cache-write', true, false, 14, 5],
  ] as const)(
    'projects ordinary subscription receipt %s without inventing usage',
    async (
      prompt,
      usageComplete,
      cacheUsageKnown,
      inputTokens,
      outputTokens,
    ) => {
      const adapter = createAdapter();
      const testPlatform = await mkdtemp(
        resolve(tmpdir(), 'allrice-fake-codex-'),
      );
      await writeFile(resolve(testPlatform, '.credentials.yaml'), '{}', {
        mode: 0o600,
      });
      vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', testPlatform);
      try {
        const result = await adapter.execute(
          executionInput({
            prompt,
            provider: {
              ...snapshot('openai-codex'),
              authMode: 'platform_subscription',
              credentialReference: 'deployment:codex-default',
            },
          }),
        );
        expect(result.answer).toBe('turn-1');
        expect(result).toMatchObject({
          usageComplete,
          cacheUsageKnown,
          usage: { inputTokens, outputTokens },
        });
      } finally {
        await adapter.close();
        await rm(testPlatform, { recursive: true, force: true });
      }
    },
  );
  it('leaves ordinary Codex on its original acquisition path and permits only verified assistant protocols', async () => {
    const adapter = createAdapter();
    const acquire = vi
      .spyOn(DshRuntimePool.prototype, 'acquire')
      .mockRejectedValueOnce(Error('legacy_acquire_reached'));
    const input = executionInput({
      prompt: 'legacy path',
      provider: snapshot('openai-codex'),
    });
    await expect(adapter.execute(input)).rejects.toThrow(
      'legacy_acquire_reached',
    );
    expect(acquire).toHaveBeenCalledOnce();
    expect(() =>
      assertAssistantProviderOutputBound(input.providerSnapshot, false),
    ).not.toThrow();
    for (const route of ['openai-compatible', 'gemini'] as const)
      expect(() =>
        assertAssistantProviderOutputBound(snapshot(route), true),
      ).not.toThrow();
  });
  it.each(['openai-codex', 'deepseek-official', 'unverified-route'] as const)(
    'rejects unverified assistant output protocol %s before credentials or native acquisition',
    async (route) => {
      const resolve = vi.fn(async () => ({ apiKey: 'must-not-read' }));
      const adapter = new DshHarnessAdapter({
        credentialResolver: { resolve },
      });
      const bind = vi.fn();
      const input = executionInput({
        prompt: 'no provider call',
        provider: snapshot(route as DshExecutionSnapshot['route']),
      });
      input.assistants = {
        deliveryMode: 'legacy',
        rootRunId: randomUUID(),
        bind,
      };
      // At the Worker boundary this preflight runs before unknown accounting.
      await expect(adapter.execute(input)).rejects.toMatchObject({
        code: 'ASSISTANT_PROVIDER_OUTPUT_BOUND_UNSUPPORTED',
        retryable: false,
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(bind).not.toHaveBeenCalled();
      expect(adapter.runtimeInventory()).toEqual([]);
      await adapter.close();
    },
  );
  it('forwards ordered image attachments to the native DSH prompt', async () => {
    const adapter = createAdapter();
    const result = await adapter.execute(
      executionInput({
        prompt: 'inspect-images',
        images: [
          { mediaType: 'image/png', data: 'aW1hZ2UtMQ==', name: 'one.png' },
          {
            mediaType: 'image/jpeg',
            data: 'aW1hZ2UtMg==',
            name: 'two.jpg',
          },
        ],
      }),
    );
    expect(JSON.parse(result.answer)).toEqual({
      count: 2,
      names: ['one.png', 'two.jpg'],
      mediaTypes: ['image/png', 'image/jpeg'],
    });
  });

  it('keeps one runtime and session across turns with different tool grants', async () => {
    const adapter = createAdapter();
    let threadId: string | null = null;
    const firstInput = executionInput({ prompt: 'first' });
    firstInput.onThreadBound = async (binding) => {
      threadId = binding.threadId;
    };
    const first = await adapter.execute(firstInput);
    const secondInput = executionInput({
      prompt: 'second',
      threadId,
      sameSessionAs: firstInput,
    });
    secondInput.tools = [];
    const second = await adapter.execute(secondInput);
    expect(first.answer).toBe('turn-1');
    expect(second.answer).toBe('turn-2');
    expect(second.threadId).toBe(threadId);
  });

  it('refuses an old frozen runtime generation before credentials or native dispatch', async () => {
    const resolve = vi.fn(async () => ({ apiKey: 'must-not-read' }));
    const adapter = new DshHarnessAdapter({ credentialResolver: { resolve } });
    adapters.push(adapter);
    const input = executionInput({ prompt: 'old frozen Run' });
    input.kernel.runtimeDistributionGeneration = 'dsh-0.1.1-rc.2-b150a55';
    await expect(adapter.execute(input)).rejects.toMatchObject({
      code: 'DSH_GENERATION_MISMATCH',
      retryable: false,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(adapter.runtimeInventory()).toEqual([]);
  });

  it('rotates the DSH runtime when the immutable employee package changes', async () => {
    const adapter = createAdapter();
    let threadId: string | null = null;
    const firstInput = executionInput({
      prompt: 'first',
      runtimePackageChecksum: `sha256:${'a'.repeat(64)}`,
    });
    firstInput.onThreadBound = async (binding) => {
      threadId = binding.threadId;
    };
    const first = await adapter.execute(firstInput);
    const samePackage = await adapter.execute(
      executionInput({
        prompt: 'same package',
        sameSessionAs: firstInput,
        threadId,
        runtimePackageChecksum: `sha256:${'a'.repeat(64)}`,
      }),
    );
    const changedPackage = await adapter.execute(
      executionInput({
        prompt: 'changed package',
        sameSessionAs: firstInput,
        threadId,
        runtimePackageChecksum: `sha256:${'b'.repeat(64)}`,
      }),
    );

    expect(first.answer).toBe('turn-1');
    expect(samePackage.answer).toBe('turn-2');
    expect(changedPackage.answer).toBe('turn-1');
  });

  it('maps streaming, turn and usage events into stable HarnessEvents', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const started: string[] = [];
    const input = executionInput({ prompt: 'hello', events });
    input.onTurnStarted = async ({ turnId }) => {
      started.push(turnId);
    };

    const result = await adapter.execute(input);
    expect(events.some((event) => event.type === 'assistant.delta')).toBe(true);
    expect(
      events.find((event) => event.type === 'assistant.completed'),
    ).toMatchObject({
      text: 'turn-1',
      harness: 'dsh',
    });
    expect(
      events.find((event) => event.type === 'usage.updated'),
    ).toMatchObject({
      inputTokens: 11,
      cachedInputTokens: 3,
      outputTokens: 5,
    });
    expect(result.usage).toEqual({
      inputTokens: 11,
      cachedInputTokens: 3,
      outputTokens: 5,
    });
    expect(result.nativeContextPressure).toMatchObject({
      pressureTokens: 12000,
      projectedTokens: 13516,
      contextWindow: 200000,
    });
    expect(started).toHaveLength(1);
  });

  it('records native Skill eligibility and missing-tool failure reasons', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const input = executionInput({ prompt: 'hello', events });
    input.nativeSkills = [
      {
        id: randomUUID(),
        name: 'web-research',
        description: 'Research public information.',
        content: '# Web Research',
        checksum: `sha256:${'a'.repeat(64)}`,
        invocation: { modelInvocable: true, userInvocable: true },
        requiredToolRefs: ['web.search'],
      },
      {
        id: randomUUID(),
        name: 'workspace-briefing',
        description: 'Inspect a local workspace.',
        content: '# Workspace Briefing',
        checksum: `sha256:${'b'.repeat(64)}`,
        invocation: { modelInvocable: true, userInvocable: true },
        requiredToolRefs: ['local.fs.list'],
      },
    ];
    input.tools = [
      ...input.tools,
      { name: 'web.search', description: 'Search', inputSchema: {} },
    ];

    await adapter.execute(input);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'native.event',
          label: 'Skill 已就绪 · 1 个',
          summary: 'web-research',
          sourcePayload: expect.objectContaining({ status: 'registered' }),
        }),
        expect.objectContaining({
          type: 'native.event',
          label: 'Skill 不可用',
          status: 'failed',
          sourcePayload: expect.objectContaining({
            skillName: 'workspace-briefing',
            reason: 'required_tools_missing',
            missingTools: ['local.fs.list'],
          }),
        }),
      ]),
    );
  });

  it('does not report an authorized but inactive Skill as unavailable', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const input = executionInput({ prompt: 'hello', events });
    input.nativeSkills = [
      {
        id: randomUUID(),
        name: 'workflow-automation',
        description: 'Create an approved automation.',
        content: '# Workflow Automation',
        checksum: `sha256:${'c'.repeat(64)}`,
        invocation: { modelInvocable: true, userInvocable: true },
        requiredToolRefs: ['automation.create'],
      },
    ];
    input.authorizedToolNames = [
      ...input.tools.map((tool) => tool.name),
      'automation.create',
    ];

    await adapter.execute(input);

    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Skill 不可用',
          sourcePayload: expect.objectContaining({
            skillName: 'workflow-automation',
          }),
        }),
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Skill 已就绪 · 1 个',
          summary: 'workflow-automation',
        }),
      ]),
    );
  });

  it.each([false, true])(
    'records actual native Skill load with its frozen version (failed=%s)',
    async (failed) => {
      const adapter = createAdapter(),
        events: HarnessEvent[] = [];
      const input = executionInput({
        prompt: 'native-skill-receipt' + (failed ? '-failed' : ''),
        events,
      });
      const id = randomUUID(),
        checksum = `sha256:${'a'.repeat(64)}`;
      input.nativeSkills = [
        {
          id,
          name: 'synthetic-skill',
          description: 'Synthetic method.',
          content: '# Synthetic',
          checksum,
          invocation: { modelInvocable: true, userInvocable: true },
          requiredToolRefs: [],
        },
      ];
      input.baseSkillCatalog = {
        schemaVersion: 1,
        authority: 'skills/catalog.json',
        catalogChecksum: checksum,
        snapshotChecksum: checksum,
        skills: [
          {
            id,
            name: 'synthetic-skill',
            version: '1.2.3',
            checksum,
            source: 'allrice',
            sourceRef: 'https://example.test/skill',
            license: 'MIT',
            reviewedByLabel: 'Fixture',
          },
        ],
      };
      await adapter.execute(input);
      expect(events.find((e) => e.type === 'native.event')).toMatchObject({
        label: 'Skill 已就绪 · 1 个',
        sourcePayload: { status: 'registered' },
      });
      expect(
        events.find(
          (e) => e.type === (failed ? 'tool.failed' : 'tool.completed'),
        ),
      ).toMatchObject({
        name: 'skill',
        sourcePayload: {
          skillId: id,
          skillName: 'synthetic-skill',
          skillChecksum: checksum,
          skillVersion: '1.2.3',
          skillCatalogChecksum: checksum,
          skillStatus: failed ? 'failed' : 'loaded',
          skillLoadMs: expect.any(Number),
        },
      });
      expect(JSON.stringify(events)).not.toContain('private skill text');
    },
  );

  it('keeps unauthorized default methods out of the actual DSH directory without reporting a failed action', async () => {
    const adapter = createAdapter(),
      events: HarnessEvent[] = [];
    const input = executionInput({ prompt: 'inspect-skill-directory', events });
    const id = randomUUID(),
      checksum = `sha256:${'b'.repeat(64)}`;
    input.nativeSkills = [
      {
        id,
        name: 'synthetic-skill',
        description: 'Requires write.',
        content: '# Write',
        checksum,
        invocation: { modelInvocable: true, userInvocable: true },
        requiredToolRefs: ['cloud.process.execute'],
      },
    ];
    input.baseSkillCatalog = {
      schemaVersion: 1,
      authority: 'skills/catalog.json',
      catalogChecksum: checksum,
      snapshotChecksum: checksum,
      skills: [
        {
          id,
          name: 'synthetic-skill',
          version: '1.0.0',
          checksum,
          source: 'allrice',
          sourceRef: 'https://example.test/skill',
          license: 'MIT',
          reviewedByLabel: 'Fixture',
        },
      ],
    };
    const denied = await adapter.execute(input);
    expect(JSON.parse(denied.answer)).toEqual([]);
    expect(
      events.filter(
        (e) => e.type === 'native.event' && e.sourcePayload?.skillId === id,
      ),
    ).toEqual([]);
    input.threadId = denied.threadId;
    input.tools = [
      ...input.tools,
      {
        name: 'cloud.process.execute',
        description: 'Explicit test authorization',
        inputSchema: {},
      },
    ];
    const allowed = await adapter.execute(input);
    expect(JSON.parse(allowed.answer)).toEqual([
      { id, name: 'synthetic-skill', description: 'Requires write.' },
    ]);
    input.threadId = allowed.threadId;
    input.nativeSkills[0]!.description = 'Updated directory description.';
    input.baseSkillCatalog.snapshotChecksum = `sha256:${'c'.repeat(64)}`;
    input.baseSkillCatalog.skills[0]!.version = '1.0.1';
    const revised = await adapter.execute(input);
    expect(JSON.parse(revised.answer)).toEqual([
      {
        id,
        name: 'synthetic-skill',
        description: 'Updated directory description.',
      },
    ]);
  });

  it('persists one frozen directory and measures its write, then reuses it on the next Run', async () => {
    const adapter = createAdapter(),
      events: HarnessEvent[] = [];
    const input = executionInput({ prompt: 'first', events });
    input.nativeSkills = Array.from({ length: 13 }, (_, i) => ({
      id: randomUUID(),
      name: `method-${i}`,
      description: 'Synthetic method',
      content: 'private skill instructions',
      checksum: `sha256:${'a'.repeat(64)}`,
      invocation: { modelInvocable: true, userInvocable: true },
      requiredToolRefs: [],
    }));
    const readyWrites: HarnessEvent[] = [];
    input.onEvent = async (event) => {
      if (event.sourceEventType === 'allrice/skill-readiness') {
        readyWrites.push(event);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      events.push(event);
    };
    const first = await adapter.execute(input);
    expect(readyWrites).toHaveLength(1);
    expect(readyWrites[0]).toMatchObject({
      label: 'Skill 已就绪 · 13 个',
      sourcePayload: {
        status: 'registered',
        count: 13,
        skills: input.nativeSkills.map((s) => ({
          skillId: s.id,
          skillName: s.name,
          skillChecksum: s.checksum,
        })),
      },
    });
    const prep = () =>
      events.find((e) => e.sourceEventType === 'allrice/runtime-preparation')!
        .sourcePayload!;
    expect(prep()).toMatchObject({
      cache: 'miss',
      reason: 'not_resident',
      registeredSkillCount: 13,
      skillEventCount: 1,
    });
    expect(prep().skillEventsPersistenceMs).toBeGreaterThanOrEqual(25);
    expect(prep().preparationMs).toBeGreaterThanOrEqual(
      Number(prep().skillEventsPersistenceMs),
    );
    expect(JSON.stringify(events)).not.toContain('private skill instructions');
    expect(JSON.stringify(events)).not.toContain('test-secret');
    const runtimeId = prep().runtimeId;
    events.length = 0;
    input.threadId = first.threadId;
    await adapter.execute(input);
    expect(readyWrites).toHaveLength(1);
    expect(prep()).toMatchObject({
      runtimeId,
      cache: 'hit',
      reason: 'reused',
      initializeMs: 0,
      skillRegistrationMs: 0,
      skillEventCount: 0,
    });
    input.nativeSkills[0]!.checksum = `sha256:${'b'.repeat(64)}`;
    events.length = 0;
    await adapter.execute(input);
    expect(readyWrites).toHaveLength(2);
    expect(prep()).toMatchObject({
      cache: 'miss',
      reason: 'configuration_changed',
      changedFields: ['nativeSkills'],
    });
    expect(prep().runtimeId).not.toBe(runtimeId);
  });

  it('announces Skills only on cold load, including a changed Skill version', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const input = executionInput({ prompt: 'first', events });
    input.nativeSkills = [
      {
        id: randomUUID(),
        name: 'synthetic-skill',
        description: 'Synthetic skill.',
        content: '# Synthetic',
        checksum: `sha256:${'a'.repeat(64)}`,
        invocation: { modelInvocable: true, userInvocable: true },
        requiredToolRefs: [],
      },
    ];
    const loaded = () =>
      events.filter(
        (event) =>
          event.type === 'native.event' &&
          event.label.startsWith('Skill 已就绪 ·'),
      );
    const first = await adapter.execute(input);
    expect(loaded()).toHaveLength(1);
    input.threadId = first.threadId;
    input.kernel.userRequest = 'second';
    events.length = 0;
    const second = await adapter.execute(input);
    expect(second.answer).toBe('turn-2');
    expect(loaded()).toHaveLength(0);
    input.nativeSkills[0]!.checksum = `sha256:${'b'.repeat(64)}`;
    input.nativeSkills[0]!.content = '# Revised synthetic';
    events.length = 0;
    await adapter.execute(input);
    expect(loaded()).toHaveLength(1);
  });

  it('loads an authorized Skill once its required tool is active this turn', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const input = executionInput({ prompt: 'create automation', events });
    input.nativeSkills = [
      {
        id: randomUUID(),
        name: 'workflow-automation',
        description: 'Create an approved automation.',
        content: '# Workflow Automation',
        checksum: `sha256:${'d'.repeat(64)}`,
        invocation: { modelInvocable: true, userInvocable: true },
        requiredToolRefs: ['automation.create'],
      },
    ];
    input.authorizedToolNames = [
      ...input.tools.map((tool) => tool.name),
      'automation.create',
    ];
    input.tools = [
      ...input.tools,
      {
        name: 'automation.create',
        description: 'Create automation',
        inputSchema: {},
      },
    ];

    await adapter.execute(input);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Skill 已就绪 · 1 个',
          summary: 'workflow-automation',
          sourcePayload: expect.objectContaining({ status: 'registered' }),
        }),
      ]),
    );
  });

  it('keeps provider reasoning private while streaming the visible answer', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const result = await adapter.execute(
      executionInput({ prompt: 'think-first', events }),
    );
    const streamed = events
      .filter(
        (event) =>
          event.type === 'assistant.delta' && event.textMode !== 'replace',
      )
      .map((event) => ('text' in event ? event.text : ''))
      .join('');
    expect(result.answer).toBe('visible answer');
    expect(streamed).toBe('visible answer');
    expect(streamed).not.toContain('private reasoning');
    const nativeEvents = events.filter(
      (event) => event.type === 'native.event',
    );
    expect(nativeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          presentation: 'think',
          status: 'started',
        }),
        expect.objectContaining({
          presentation: 'think',
          status: 'completed',
        }),
      ]),
    );
    expect(JSON.stringify(nativeEvents)).not.toContain('private reasoning');
    expect(JSON.stringify(events)).not.toContain(
      'system-secret-that-must-not-reach-chatflow',
    );
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it.each(['TOOL_FILE_TYPE_UNSUPPORTED', 'TOOL_FILE_TOO_LARGE'])(
    'returns %s to DSH without replaying file work',
    async (code) => {
      const adapter = createAdapter();
      const events: HarnessEvent[] = [];
      const onToolCall = vi
        .fn()
        .mockRejectedValue(new HandlerError(code, '选择可读取的文件', false));
      const progress = vi.fn().mockResolvedValue({});
      const input = executionInput({ prompt: 'use-tool', events, onToolCall });
      input.progress = progress;
      const result = await adapter.execute(input);
      expect(result.answer).toBe('tool-finished');
      expect(onToolCall).toHaveBeenCalledTimes(1);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool.failed',
            name: 'workspace.file.read',
          }),
        ]),
      );
      expect(progress).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'finish', outcome: 'error' }),
      );
    },
  );

  it.each(['TOOL_CAPABILITY_DENIED', 'COMPANY_REFERENCE_UNAVAILABLE'])(
    'keeps %s fatal at the read admission boundary',
    async (code) => {
      const adapter = createAdapter();
      const onToolCall = vi
        .fn()
        .mockRejectedValue(new HandlerError(code, '访问已撤销', false));
      await expect(
        adapter.execute(
          executionInput({ prompt: 'use-tool', events: [], onToolCall }),
        ),
      ).rejects.toMatchObject({ code });
      expect(onToolCall).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['unconfirmed', 'run', 'call', 'name', 'serialized'] as const)(
    'does not recover a %s failure receipt from an error code alone',
    async (mismatch) => {
      const adapter = createAdapter();
      const events: HarnessEvent[] = [];
      const progress = vi.fn().mockResolvedValue({});
      let failure = new HandlerError(
        'AUTOMATION_REQUEST_UNCLEAR',
        '未创建任务',
        false,
      );
      const input = executionInput({
        prompt: 'use-tool',
        events,
        onToolCall: async (call) => {
          if (mismatch !== 'unconfirmed')
            confirmToolFailure(failure, {
              runId:
                mismatch === 'run'
                  ? randomUUID()
                  : input.executionEnvironment.ALLRICE_RUN_ID!,
              callId: mismatch === 'call' ? randomUUID() : call.id,
              toolName: mismatch === 'name' ? 'automation.create' : call.name,
            });
          if (mismatch === 'serialized')
            failure = Object.assign(
              new HandlerError(failure.code, failure.message, false),
              JSON.parse(JSON.stringify(failure)),
            );
          throw failure;
        },
      });
      input.progress = progress;
      const thrown = await adapter
        .execute(input)
        .catch((error: unknown) => error);
      expect(thrown).toBe(failure);
      expect(progress.mock.calls.map(([value]) => value)).not.toContainEqual(
        expect.objectContaining({ action: 'finish', kind: 'tool' }),
      );
      expect(events.some((event) => event.type === 'assistant.completed')).toBe(
        false,
      );
    },
  );

  it('does not recover a confirmed rejection after cancellation or a failed tool progress settlement', async () => {
    for (const scenario of ['canceled', 'lease-lost'] as const) {
      const adapter = createAdapter();
      const controller = new AbortController();
      const events: HarnessEvent[] = [];
      const failure = new HandlerError(
        'AUTOMATION_REQUEST_UNCLEAR',
        '未创建任务',
        false,
      );
      const leaseLost = new HandlerError('TASK_LEASE_LOST', '租约失效', false);
      const input = executionInput({
        prompt: 'use-tool',
        signal: controller.signal,
        events,
        onToolCall: async (call) => {
          confirmToolFailure(failure, {
            runId: input.executionEnvironment.ALLRICE_RUN_ID!,
            callId: call.id,
            toolName: call.name,
          });
          if (scenario === 'canceled') controller.abort();
          throw failure;
        },
      });
      input.progress = vi.fn(async (value) => {
        if (value.action === 'finish' && value.kind === 'tool') throw leaseLost;
        return {};
      });
      await expect(adapter.execute(input)).rejects.toMatchObject({
        code: scenario === 'canceled' ? 'EXECUTION_ABORTED' : 'TASK_LEASE_LOST',
      });
      expect(events.some((event) => event.type === 'assistant.completed')).toBe(
        false,
      );
    }
  });

  it('routes tool envelopes only through the AllRice Tool Broker callback', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const calls: string[] = [];
    const result = await adapter.execute(
      executionInput({
        prompt: 'use-tool',
        events,
        onToolCall: async (call) => {
          calls.push(call.name);
          return {
            modelContent: '[{"id":"one"}]',
            summary: 'one file',
            itemCount: 1,
          };
        },
      }),
    );
    expect(result.answer).toBe('tool-finished');
    expect(calls).toEqual(['workspace.file.read']);
    expect(
      events.filter((event) => event.type.startsWith('tool.')),
    ).toHaveLength(2);
    expect(
      events
        .filter((event) => event.type === 'assistant.delta')
        .map((event) => ('text' in event ? event.text : ''))
        .join(''),
    ).not.toContain('allrice_tool_call');
  });

  it('keeps native DSH search inside one turn and projects its tool events', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const calls: string[] = [];
    const started: string[] = [];
    const input = executionInput({
      prompt: 'native-search',
      events,
      onToolCall: async (call) => {
        calls.push(call.name);
        return { modelContent: 'unused', summary: 'unused' };
      },
    });
    input.tools = [
      {
        name: 'web.search',
        description: 'Search the web',
        inputSchema: { type: 'object' },
      },
    ];
    input.onTurnStarted = async ({ turnId }) => {
      started.push(turnId);
    };
    const result = await adapter.execute(input);

    expect(result.answer).toBe('native-search-finished');
    expect(events.find((event) => event.type === 'tool.started')).toMatchObject(
      {
        sourcePayload: { activityDetail: '搜索资料：NVIDIA price' },
      },
    );
    expect(started).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(events.filter((event) => event.type.startsWith('tool.'))).toEqual([
      expect.objectContaining({
        type: 'tool.started',
        name: 'web.search',
        source: 'harness',
      }),
      expect.objectContaining({
        type: 'tool.completed',
        name: 'web.search',
        source: 'harness',
      }),
    ]);
  });

  it.each([
    ['failed', 'tool.failed', 'failed', '工具执行失败'],
    ['succeeded', 'tool.completed', 'completed', '工具执行完成'],
    ['legacy-error', 'tool.failed', 'failed', '工具执行失败'],
    ['truthy-string', 'tool.completed', 'completed', '工具执行完成'],
    ['legacy-success', 'tool.completed', 'completed', '工具执行完成'],
  ])(
    'projects native result %s without exposing raw result or reasoning',
    async (outcome, type, status, summary) => {
      const events: HarnessEvent[] = [];
      const result = await createAdapter().execute(
        executionInput({
          prompt: `native-result-outcome:${outcome}`,
          events,
        }),
      );
      expect(result.answer).toBe('native-result-outcome-finished');
      expect(events.filter((event) => event.type.startsWith('tool.'))).toEqual([
        expect.objectContaining({
          type: 'tool.started',
          name: 'local.fs.list',
          toolCallId: 'native-result-outcome-1',
        }),
        expect.objectContaining({
          type,
          name: 'local.fs.list',
          toolCallId: 'native-result-outcome-1',
          summary,
          source: 'harness',
          sourcePayload: expect.objectContaining({ status }),
        }),
      ]);
      expect(JSON.stringify(events)).not.toMatch(
        /private-tool-arguments|private-tool-result|private-error-text|private reasoning/,
      );
    },
  );

  it('routes native local tools through the active AllRice Tool Broker', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const calls: Array<{ id: string; name: string; arguments: unknown }> = [];
    const input = executionInput({
      prompt: 'native-local',
      events,
      onToolCall: async (call) => {
        calls.push(call);
        return {
          modelContent: JSON.stringify({ entries: ['project-a'] }),
          summary: '找到 1 个本地项目',
          itemCount: 1,
        };
      },
    });
    input.tools = [
      {
        name: 'local.fs.list',
        description: 'List authorized local files',
        inputSchema: { type: 'object' },
      },
    ];

    const result = await adapter.execute(input);

    expect(result.answer).toBe('native-local-finished');
    expect(calls).toEqual([
      {
        id: 'native-local-1',
        name: 'local.fs.list',
        arguments: { path: '.', limit: 20 },
      },
    ]);
    expect(events.filter((event) => event.type.startsWith('tool.'))).toEqual([
      expect.objectContaining({
        type: 'tool.started',
        name: 'local.fs.list',
        source: 'harness',
      }),
      expect.objectContaining({
        type: 'tool.completed',
        name: 'local.fs.list',
        source: 'harness',
      }),
    ]);
    expect(
      events
        .filter((event) => event.type === 'assistant.delta')
        .map((event) => ('text' in event ? event.text : ''))
        .join(''),
    ).not.toContain('allrice_tool_call');
  });

  it('routes cloud WeChat native tools through the active Tool Broker as search events', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const calls: Array<{ id: string; name: string; arguments: unknown }> = [];
    const input = executionInput({
      prompt: 'native-wechat',
      events,
      onToolCall: async (call) => {
        calls.push(call);
        return {
          modelContent: JSON.stringify({
            provider: 'sogou-weixin',
            results: [{ title: 'AllRice' }],
          }),
          summary: '找到 1 篇公众号公开文章',
          itemCount: 1,
        };
      },
    });
    input.tools = [
      {
        name: 'wechat.article.search',
        description: 'Search public WeChat articles',
        inputSchema: { type: 'object' },
      },
    ];

    const result = await adapter.execute(input);

    expect(result.answer).toBe('native-wechat-finished');
    expect(calls).toEqual([
      {
        id: 'native-wechat-1',
        name: 'wechat.article.search',
        arguments: { query: 'AllRice', limit: 3 },
      },
    ]);
    expect(events.filter((event) => event.type.startsWith('tool.'))).toEqual([
      expect.objectContaining({
        type: 'tool.started',
        name: 'wechat.article.search',
        source: 'harness',
        sourcePayload: expect.objectContaining({ presentation: 'search' }),
      }),
      expect.objectContaining({
        type: 'tool.completed',
        name: 'wechat.article.search',
        source: 'harness',
        sourcePayload: expect.objectContaining({ presentation: 'search' }),
      }),
    ]);
  });

  it('advertises native and bridged tools together without hiding native tools', async () => {
    const adapter = createAdapter();
    const input = executionInput({ prompt: 'inspect-mixed-tool-instructions' });
    input.tools = [
      ...input.tools,
      {
        name: 'local.fs.list',
        description: 'List authorized local files',
        inputSchema: { type: 'object' },
      },
    ];

    const result = await adapter.execute(input);

    expect(JSON.parse(result.answer)).toEqual({
      nativeLocalAdvertised: true,
      bridgedToolsAdvertised: true,
      incorrectlyClaimsOnlyBridgedTools: false,
    });
  });

  it('accepts a single tool envelope after a harmless model preamble', async () => {
    const adapter = createAdapter();
    const calls: string[] = [];
    const result = await adapter.execute(
      executionInput({
        prompt: 'use-tool-with-preamble',
        onToolCall: async (call) => {
          calls.push(call.name);
          return {
            modelContent: '[{"id":"one"}]',
            summary: 'one file',
            itemCount: 1,
          };
        },
      }),
    );
    expect(calls).toEqual(['workspace.file.read']);
    expect(result.answer).toBe('tool-finished');
    expect(result.answer).not.toContain('allrice_tool_call');
  });

  it('accepts a single tool envelope before a harmless model postamble', async () => {
    const adapter = createAdapter();
    const calls: string[] = [];
    const result = await adapter.execute(
      executionInput({
        prompt: 'use-tool-with-postamble',
        onToolCall: async (call) => {
          calls.push(call.name);
          return {
            modelContent: '[{"id":"one"}]',
            summary: 'one file',
            itemCount: 1,
          };
        },
      }),
    );
    expect(calls).toEqual(['workspace.file.read']);
    expect(result.answer).toBe('tool-finished');
    expect(result.answer).not.toContain('allrice_tool_call');
  });

  it.each(['deepseek-official', 'openai-compatible'] as const)(
    'supports the %s route without inheriting Worker secrets',
    async (route) => {
      process.env.ALLRICE_TEST_MUST_NOT_LEAK = 'sensitive';
      try {
        const adapter = createAdapter();
        const result = await adapter.execute(
          executionInput({ prompt: 'show-env', provider: snapshot(route) }),
        );
        const observed = JSON.parse(result.answer) as {
          provider: string;
          keys: string[];
          hasDeepSeek: boolean;
          hasOpenAiCompatible: boolean;
        };
        expect(observed.provider).toBe(route);
        expect(observed.keys).not.toContain('ALLRICE_TEST_MUST_NOT_LEAK');
        expect(observed.hasDeepSeek).toBe(route === 'deepseek-official');
        expect(observed.hasOpenAiCompatible).toBe(
          route === 'openai-compatible',
        );
      } finally {
        delete process.env.ALLRICE_TEST_MUST_NOT_LEAK;
      }
    },
  );

  it('interrupts one hung session and can recover with a clean runtime', async () => {
    const adapter = createAdapter();
    const controller = new AbortController();
    let threadId: string | null = null;
    const input = executionInput({
      prompt: 'hang forever',
      signal: controller.signal,
    });
    input.onThreadBound = async (binding) => {
      threadId = binding.threadId;
    };
    const run = adapter.execute(input);
    setTimeout(() => controller.abort(), 50);
    await expect(run).rejects.toThrow('interrupted');
    expect(threadId).not.toBeNull();
    const recovered = await adapter.execute(
      executionInput({ prompt: 'after recovery', threadId }),
    );
    expect(recovered.answer).toBe('turn-1');
  });

  it.each([false, true])(
    'never reports an empty success when canceled before dispatch (progress %s)',
    async (progress) => {
      const adapter = createAdapter(),
        controller = new AbortController();
      const input = executionInput({
        prompt: 'must not start',
        signal: controller.signal,
      });
      if (progress) input.progress = async () => ({ paused: false });
      input.onThreadBound = async () => {
        controller.abort();
      };
      await expect(adapter.execute(input)).rejects.toThrow('interrupted');
    },
  );

  it('refuses an old runtime before dispatch when required progress protection is not acknowledged', async () => {
    const adapter = createAdapter();
    const input = executionInput({
      prompt: 'must not start',
      provider: { ...snapshot('openai-compatible'), model: 'legacy-progress' },
    });
    input.progress = async () => ({ paused: false });
    await expect(adapter.execute(input)).rejects.toThrow(
      'required progress guard',
    );
  });

  it('uses DSH native compaction without replacing the live session', async () => {
    const adapter = createAdapter();
    let threadId: string | null = null;
    const input = executionInput({ prompt: 'before compact' });
    input.onThreadBound = async (binding) => {
      threadId = binding.threadId;
    };
    await adapter.execute(input);
    await adapter.compact({ threadId: threadId! });
    const after = await adapter.execute(
      executionInput({
        prompt: 'after compact',
        threadId,
        sameSessionAs: input,
      }),
    );
    expect(after.answer).toBe('turn-2');
  });
});

vi.mock('../codex-subscription-home.js', async (original) => {
  const actual = await original<typeof SubscriptionHome>();
  return {
    ...actual,
    activeCodexSubscriptionHome: async () => actual.codexSubscriptionHome(1),
  };
});
