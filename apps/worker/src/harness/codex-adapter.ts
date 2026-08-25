import { HarnessEventSchema, type HarnessEvent } from '@allrice/contracts';

import { executeCodexHarness, type NormalizedCodexEvent } from '../codex.js';
import type {
  HarnessAdapter,
  HarnessExecutionInput,
  HarnessExecutionResult,
} from './adapter.js';

function eventType(event: NormalizedCodexEvent): HarnessEvent['type'] {
  if (event.kind === 'message') return 'assistant.completed';
  if (event.kind === 'usage') return 'usage.updated';
  if (event.status === 'started') return 'tool.started';
  if (event.status === 'failed') return 'tool.failed';
  return 'tool.completed';
}

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly kind = 'codex' as const;
  readonly capabilities = {
    persistentThreads: true,
    assistantDeltas: false,
    toolEvents: true,
    usageEvents: true,
    interrupt: true,
    steer: false,
    compact: false,
    recover: true,
  } as const;

  async execute(input: HarnessExecutionInput): Promise<HarnessExecutionResult> {
    let order = 0;
    let generation = input.generation;
    let threadId = input.threadId ?? null;
    let turnId: string | null = null;
    const emit = async (event: NormalizedCodexEvent) => {
      const type = eventType(event);
      const envelope = {
        schemaVersion: 1 as const,
        harness: this.kind,
        generation,
        attempt: input.attempt,
        order: ++order,
        threadId,
        turnId,
      };
      const normalized =
        event.kind === 'message'
          ? { ...envelope, type, text: event.text ?? '' }
          : event.kind === 'usage'
            ? {
                ...envelope,
                type,
                inputTokens: event.usage?.inputTokens ?? 0,
                cachedInputTokens: event.usage?.cachedInputTokens ?? 0,
                outputTokens: event.usage?.outputTokens ?? 0,
              }
            : {
                ...envelope,
                type,
                toolCallId: event.toolCallId ?? `${event.name}-unknown`,
                name: event.name ?? 'unknown',
                label: event.label ?? event.name ?? '工具调用',
                source:
                  event.source === 'tool_broker'
                    ? ('tool_broker' as const)
                    : ('harness' as const),
                ...(event.summary ? { summary: event.summary } : {}),
                ...(event.itemCount === undefined
                  ? {}
                  : { itemCount: event.itemCount }),
              };
      await input.onEvent(HarnessEventSchema.parse(normalized));
    };
    const result = await executeCodexHarness({
      storageObjects: input.storageObjects,
      workDirectory: input.workDirectory,
      executionEnvironment: input.executionEnvironment,
      systemInstructions: input.kernel.systemInstructions,
      prompt: input.kernel.userRequest,
      providerSnapshot: input.providerSnapshot,
      grantedCapabilities: input.kernel.grantedCapabilities,
      signal: input.signal,
      onEvent: emit,
      toolDefinitions: input.tools,
      onToolCall: input.onToolCall,
      conversationRuntime: {
        threadId,
        clientUserMessageId: input.kernel.userMessageId,
        bootstrapConversation: input.kernel.bootstrapConversation,
        turnContext: input.kernel.authorizedMemoryContext || undefined,
        onThreadBound: async (binding) => {
          threadId = binding.threadId;
          const bound = await input.onThreadBound?.(binding);
          generation = bound?.generation ?? generation;
        },
        onTurnStarted: async (turn) => {
          threadId = turn.threadId;
          turnId = turn.turnId;
          await input.onTurnStarted?.(turn);
        },
      },
    });
    return { ...result, threadId, turnId };
  }
}
