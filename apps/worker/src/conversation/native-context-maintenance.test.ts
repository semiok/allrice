import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { finalizeEmployeeConversationContext } from './checkpoint-maintenance.js';

const state = vi.hoisted(() => ({
  clear: vi.fn(),
  native: vi.fn(),
  usage: vi.fn(),
  save: vi.fn(),
  memory: vi.fn(),
  events: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  clearConversationTurn: state.clear,
  recordConversationNativeContext: state.native,
  recordConversationUsage: state.usage,
  saveContextCheckpoint: state.save,
  createCheckpointMemoryCandidate: state.memory,
  appendJobEvent: state.events,
}));
const runtime = {
  threadId: 'native-original',
  generation: 4,
  activeTurnId: 'native-turn',
  usageBaselineInputTokens: 477758,
  compactThresholdTokens: 40000,
  contextPressureTokens: 2267998,
};
beforeEach(() => {
  vi.clearAllMocks();
  state.clear.mockResolvedValue(runtime);
  state.native.mockResolvedValue(runtime);
});

it.each([false, true])(
  'projects only an observed native meter; present=%s',
  async (present) => {
    const measurement = {
      pressureTokens: 149071,
      projectedTokens: 149180,
      contextWindow: 272000,
      asOfSeq: 442,
    };
    const input = {
      ownership: { sessionId: 'session' },
      adapter: { kind: 'dsh', contextStrategy: 'harness-native' },
      result: {
        usage: {
          inputTokens: 2745756,
          cachedInputTokens: 2708224,
          outputTokens: 10960,
        },
        ...(present ? { nativeContextPressure: measurement } : {}),
      },
    } as Parameters<typeof finalizeEmployeeConversationContext>[0];
    const usage = { ...input.result.usage };
    expect(await finalizeEmployeeConversationContext(input)).toBe(runtime);
    expect(state.clear).toHaveBeenCalledWith(input.ownership);
    expect(state.native).toHaveBeenCalledTimes(present ? 1 : 0);
    if (present)
      expect(state.native).toHaveBeenCalledWith({
        ...input.ownership,
        generation: 4,
        ...measurement,
      });
    expect(input.result.usage).toEqual(usage);
    for (const legacy of [state.usage, state.save, state.memory, state.events])
      expect(legacy).not.toHaveBeenCalled();
  },
);

it('retains the owned native turn for final commit and rejects an unsafe boundary', async () => {
  const input = {
    ownership: { sessionId: 'session' },
    adapter: { kind: 'dsh', contextStrategy: 'harness-native' },
    result: {
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    },
    retainTurnUntilCommit: runtime,
  } as Parameters<typeof finalizeEmployeeConversationContext>[0];
  expect(await finalizeEmployeeConversationContext(input)).toBe(runtime);
  expect(state.clear).not.toHaveBeenCalled();
  input.retainTurnUntilCommit = {
    ...input.retainTurnUntilCommit!,
    activeTurnId: null,
  };
  await expect(finalizeEmployeeConversationContext(input)).rejects.toThrow(
    'context_checkpoint_unsafe_boundary',
  );
  expect(state.clear).not.toHaveBeenCalled();
});
