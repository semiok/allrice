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
        sessionId: '00000000-0000-4000-8000-000000000001',
        harness: 'codex',
        threadId: 'thread-1',
        generation: 2,
        coveredThroughMessageId: null,
        summary: 'User is implementing a harness boundary.',
        checksum: `sha256:${'a'.repeat(64)}`,
        estimatedTokens: 12,
      }),
    ).toMatchObject({ generation: 2, estimatedTokens: 12 });
  });
});
