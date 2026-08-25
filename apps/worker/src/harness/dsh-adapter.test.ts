import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { DshExecutionSnapshot, HarnessEvent } from '@allrice/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { HarnessExecutionInput } from './adapter.js';
import { DshHarnessAdapter } from './dsh-adapter.js';

const adapters: DshHarnessAdapter[] = [];

afterEach(async () => {
  await Promise.allSettled(
    adapters.splice(0).map((adapter) => adapter.close()),
  );
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
      resolve('apps/worker/src/harness/fixtures/dsh-fake-runtime.mjs'),
    ],
    runtimeRoot: resolve('.local/test-dsh-runtime'),
    cordisConfig: resolve('apps/worker/dsh/allrice-restricted.cordis.yml'),
    requestTimeoutMs: 5_000,
  });
  adapters.push(adapter);
  return adapter;
}

function executionInput(input: {
  prompt: string;
  provider?: DshExecutionSnapshot;
  threadId?: string | null;
  signal?: AbortSignal;
  events?: HarnessEvent[];
  onToolCall?: HarnessExecutionInput['onToolCall'];
}): HarnessExecutionInput {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const events = input.events ?? [];
  return {
    kernel: {
      schemaVersion: 1,
      harness: 'dsh',
      employeeAssignmentId: randomUUID(),
      employeeVersionId: randomUUID(),
      sessionId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      systemInstructions: 'You are Rice.',
      userRequest: input.prompt,
      bootstrapConversation: '',
      authorizedMemoryContext: '',
      grantedCapabilities: ['model:invoke', 'storage:read'],
      skillVersionIds: [],
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
        name: 'workspace.file.list',
        description: 'List files',
        inputSchema: { type: 'object' },
      },
    ],
    onToolCall: input.onToolCall,
    onEvent: async (event) => {
      events.push(event);
    },
  };
}

describe('DshHarnessAdapter', () => {
  it('keeps one runtime and session across turns with different tool grants', async () => {
    const adapter = createAdapter();
    let threadId: string | null = null;
    const firstInput = executionInput({ prompt: 'first' });
    firstInput.onThreadBound = async (binding) => {
      threadId = binding.threadId;
    };
    const first = await adapter.execute(firstInput);
    const secondInput = executionInput({ prompt: 'second', threadId });
    secondInput.tools = [];
    const second = await adapter.execute(secondInput);
    expect(first.answer).toBe('turn-1');
    expect(second.answer).toBe('turn-2');
    expect(second.threadId).toBe(threadId);
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
    expect(started).toHaveLength(1);
  });

  it('keeps provider reasoning private while streaming the visible answer', async () => {
    const adapter = createAdapter();
    const events: HarnessEvent[] = [];
    const result = await adapter.execute(
      executionInput({ prompt: 'think-first', events }),
    );
    const streamed = events
      .filter((event) => event.type === 'assistant.delta')
      .map((event) => ('text' in event ? event.text : ''))
      .join('');
    expect(result.answer).toBe('visible answer');
    expect(streamed).toBe('visible answer');
    expect(streamed).not.toContain('private reasoning');
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
    expect(calls).toEqual(['workspace.file.list']);
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

  it('compacts by closing native state before AllRice checkpoint rehydration', async () => {
    const adapter = createAdapter();
    let threadId: string | null = null;
    const input = executionInput({ prompt: 'before compact' });
    input.onThreadBound = async (binding) => {
      threadId = binding.threadId;
    };
    await adapter.execute(input);
    await adapter.compact({ threadId: threadId! });
    const after = await adapter.execute(
      executionInput({ prompt: 'after compact', threadId }),
    );
    expect(after.answer).toBe('turn-1');
  });
});
