import { describe, expect, it } from 'vitest';

import {
  buildExtractiveContextSummary,
  contextCheckpointChecksum,
  estimateConversationTokens,
  shouldCreateContextCheckpoint,
} from './conversation-checkpoint.js';
import {
  conversationUsageWatermark,
  effectiveContextTokens,
} from './conversation-usage.js';

describe('context checkpoint planning', () => {
  it('creates a stable checksum for a recovery snapshot', () => {
    const values = {
      sessionId: '00000000-0000-4000-8000-000000000001',
      harness: 'codex' as const,
      threadId: 'thread-1',
      generation: 2,
      coveredThroughMessageId: '00000000-0000-4000-8000-000000000002',
      summaryVersion: 'extractive-v1' as const,
      summary: '目标：交付周报。',
      configChecksum: `sha256:${'a'.repeat(64)}`,
      estimatedTokens: 20,
      messageCount: 4,
    };
    expect(contextCheckpointChecksum(values)).toBe(
      contextCheckpointChecksum({ ...values }),
    );
    expect(contextCheckpointChecksum(values)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('preserves early decisions and a recent verbatim window', () => {
    const summary = buildExtractiveContextSummary({
      messages: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          role: 'user',
          text: '目标是完成 AllRice 架构升级。',
        },
        ...Array.from({ length: 20 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
          role: 'assistant' as const,
          text: `普通消息 ${index + 1}`,
        })),
        {
          id: '00000000-0000-4000-8000-000000000099',
          role: 'user',
          text: '待办：部署 dev。',
        },
      ],
    });
    expect(summary).toContain('目标是完成 AllRice 架构升级');
    expect(summary).toContain('普通消息 20');
    expect(summary).toContain('待办：部署 dev');
  });

  it('only checkpoints a new covered range above threshold', () => {
    expect(
      shouldCreateContextCheckpoint({
        estimatedTokens: 2_000,
        thresholdTokens: 1_000,
        coveredThroughMessageId: 'message-2',
        latestCoveredThroughMessageId: 'message-1',
      }),
    ).toBe(true);
    expect(
      shouldCreateContextCheckpoint({
        estimatedTokens: 2_000,
        thresholdTokens: 1_000,
        coveredThroughMessageId: 'message-1',
        latestCoveredThroughMessageId: 'message-1',
      }),
    ).toBe(false);
    expect(estimateConversationTokens('你好')).toBeGreaterThan(0);
  });

  it('subtracts the fixed harness baseline before evaluating compaction', () => {
    const first = conversationUsageWatermark({
      baselineInputTokens: null,
      inputTokens: 8_590,
    });
    expect(first).toEqual({
      baselineInputTokens: 8_590,
      inputTokens: 8_590,
      dynamicContextTokens: 0,
    });

    const latest = conversationUsageWatermark({
      baselineInputTokens: first.baselineInputTokens,
      inputTokens: 13_516,
    });
    expect(latest.dynamicContextTokens).toBe(4_926);
    expect(
      effectiveContextTokens({
        applicationEstimatedTokens: 520,
        observedDynamicTokens: latest.dynamicContextTokens,
      }),
    ).toBe(4_926);
    expect(
      shouldCreateContextCheckpoint({
        estimatedTokens: latest.dynamicContextTokens,
        thresholdTokens: 40_000,
        coveredThroughMessageId: 'message-2',
      }),
    ).toBe(false);
  });

  it('never reports negative dynamic context after a provider reset', () => {
    expect(
      conversationUsageWatermark({
        baselineInputTokens: 8_590,
        inputTokens: 1_000,
      }).dynamicContextTokens,
    ).toBe(0);
  });
});
