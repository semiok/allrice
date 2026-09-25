import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { DshExecutionSnapshot, HarnessEvent } from '@allrice/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HarnessExecutionInput } from './adapter.js';
import { DshRuntimePool, type DshRuntime } from './dsh/runtime-pool.js';
import { DshStartupRejection } from './dsh/startup-rejection.js';
import { HandlerError } from '../errors.js';
import { getAssistantFailureUsage } from './dsh/assistant-outcome.js';
import { assertAssistantProviderOutputBound } from './dsh/assistant-provider.js';
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

describe('DshHarnessAdapter', () => {
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
      });
      const drop = vi
        .spyOn(DshRuntimePool.prototype, 'drop')
        .mockResolvedValue();
      input.assistants = {
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
      input.assistants = { rootRunId: randomUUID(), bind };
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
    const secondInput = executionInput({ prompt: 'second', threadId });
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
        threadId,
        runtimePackageChecksum: `sha256:${'a'.repeat(64)}`,
      }),
    );
    const changedPackage = await adapter.execute(
      executionInput({
        prompt: 'changed package',
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
          label: 'Skill 已加载',
          summary: 'web-research',
          sourcePayload: expect.objectContaining({ status: 'loaded' }),
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
          label: 'Skill 已加载',
          summary: 'workflow-automation',
        }),
      ]),
    );
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
          label: 'Skill 已加载',
          summary: 'workflow-automation',
          sourcePayload: expect.objectContaining({ status: 'loaded' }),
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
      executionInput({ prompt: 'after compact', threadId }),
    );
    expect(after.answer).toBe('turn-2');
  });
});
