import { describe, expect, it } from 'vitest';

import {
  ContextCheckpointSchema,
  HarnessCapabilitiesSchema,
  HarnessEventSchema,
} from './harness.ts';

describe('harness contracts', () => {
  it('keeps adapter capabilities explicit', () => {
    expect(
      HarnessCapabilitiesSchema.parse({
        persistentThreads: true,
        assistantDeltas: false,
        toolEvents: true,
        usageEvents: true,
        interrupt: true,
        steer: false,
        compact: false,
        recover: true,
      }),
    ).toMatchObject({ steer: false, compact: false });
  });

  it('normalizes ordered events without provider-specific payloads', () => {
    expect(
      HarnessEventSchema.parse({
        schemaVersion: 1,
        harness: 'codex',
        generation: 2,
        attempt: 1,
        order: 4,
        threadId: 'thread-1',
        turnId: 'turn-1',
        sessionId: '00000000-0000-4000-8000-000000000002',
        messageId: '00000000-0000-4000-8000-000000000001',
        type: 'assistant.completed',
        text: '完成',
      }),
    ).toMatchObject({ type: 'assistant.completed', order: 4 });
  });

  it('defines a provider-neutral recovery checkpoint', () => {
    expect(
      ContextCheckpointSchema.parse({
        schemaVersion: 1,
        checkpointId: '00000000-0000-4000-8000-000000000002',
        sessionId: '00000000-0000-4000-8000-000000000001',
        harness: 'codex',
        threadId: 'thread-1',
        generation: 2,
        coveredThroughMessageId: null,
        summaryVersion: 'extractive-v1',
        summary: 'User is implementing a harness boundary.',
        checksum: `sha256:${'a'.repeat(64)}`,
        configChecksum: `sha256:${'b'.repeat(64)}`,
        estimatedTokens: 12,
        messageCount: 2,
        createdAt: '2026-08-25T00:00:00.000Z',
      }),
    ).toMatchObject({ generation: 2, estimatedTokens: 12 });
  });

  it('accepts a sanitized native presentation event', () => {
    expect(
      HarnessEventSchema.parse({
        schemaVersion: 1,
        harness: 'dsh',
        generation: 0,
        attempt: 1,
        order: 1,
        threadId: 'dsh-thread',
        turnId: 'turn-1',
        sessionId: '00000000-0000-4000-8000-000000000002',
        messageId: '00000000-0000-4000-8000-000000000001',
        sourceEventId: 'dsh:1',
        sourceEventType: 'request/context',
        sourceOccurredAt: '2026-08-27T00:00:00.000Z',
        sourcePayload: { provider: 'openai-codex' },
        type: 'native.event',
        presentation: 'context',
        status: 'info',
        label: '模型上下文',
      }),
    ).toMatchObject({ type: 'native.event', presentation: 'context' });
  });
});
