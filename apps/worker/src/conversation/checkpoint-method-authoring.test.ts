import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { finalizeEmployeeConversationContext } from './checkpoint-maintenance.js';

const state = vi.hoisted(() => ({
  authoring: false,
  save: vi.fn(),
  memory: vi.fn(),
  events: vi.fn(),
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  clearConversationTurn: async () => ({
    threadId: 'native-original',
    generation: 1,
    compactThresholdTokens: 1,
    dynamicContextTokens: 1000,
  }),
  listContextCheckpointEvidence: async () => [],
  isEmployeeMethodAuthoringRun: async () => state.authoring,
  saveContextCheckpoint: state.save,
  createCheckpointMemoryCandidate: state.memory,
  appendJobEvent: state.events,
}));
beforeEach(() => {
  vi.clearAllMocks();
  state.save.mockResolvedValue({ checkpointId: 'checkpoint' });
  state.memory.mockResolvedValue({});
  state.events.mockResolvedValue(undefined);
});
it.each([false, true])(
  'preserves the original checkpoint but excludes authoring=%s from automatic memory extraction',
  async (authoring) => {
    state.authoring = authoring;
    const compact = vi.fn(async () => {});
    const input = {
      ownership: { sessionId: 'session' },
      ownerId: 'owner',
      employeeId: 'employee',
      executionContext: {
        organizationId: 'company',
        workspaceId: 'workspace',
        runId: 'run',
        policySnapshot: { memberships: [] },
      },
      kernel: {
        bootstrapConversation: '',
        authorizedMemoryContext: '',
        userRequest: '请保存工作场景候选',
      },
      result: { usage: { inputTokens: 0 } },
      adapter: {
        capabilities: { compact: true },
        compact,
        contextStrategy: 'chatflow-managed',
        kind: 'dsh',
      },
      checkpoint: null,
      checkpointMessages: [
        {
          id: 'message',
          role: 'user',
          text: '我的偏好是 DRAFT_CHECKPOINT_MARKER',
        },
      ],
      contentGenerationId: 'content-generation',
      configChecksum: 'configuration',
      workflowLease: {},
    } as unknown as Parameters<typeof finalizeEmployeeConversationContext>[0];
    await finalizeEmployeeConversationContext(input);
    expect(compact).toHaveBeenCalledOnce();
    expect(state.save).toHaveBeenCalledOnce();
    expect(state.save.mock.calls[0]![0].summary).toContain(
      'DRAFT_CHECKPOINT_MARKER',
    );
    expect(state.memory).toHaveBeenCalledTimes(authoring ? 0 : 1);
    expect(
      state.events.mock.calls.some(
        ([e]) => e.type === 'context.compaction.failed',
      ),
    ).toBe(false);
  },
);
