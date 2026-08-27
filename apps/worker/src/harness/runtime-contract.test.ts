import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { HarnessEvent } from '@allrice/contracts';

import { normalizeHarnessRunEvent } from './runtime-contract.js';

function envelope(harness: 'codex' | 'dsh') {
  return {
    schemaVersion: 1 as const,
    harness,
    generation: 2,
    attempt: 1,
    order: 7,
    threadId: `${harness}-thread`,
    turnId: `${harness}-turn`,
    sessionId: randomUUID(),
    messageId: randomUUID(),
  };
}

describe('normalizeHarnessRunEvent', () => {
  it.each(['codex', 'dsh'] as const)(
    'maps %s deltas to the same durable contract',
    (harness) => {
      const event: HarnessEvent = {
        ...envelope(harness),
        type: 'assistant.delta',
        text: 'Rice',
      };
      expect(normalizeHarnessRunEvent(event)).toMatchObject({
        type: 'assistant.text.delta',
        payload: {
          source: harness,
          text: 'Rice',
          generation: 2,
          threadId: `${harness}-thread`,
        },
      });
    },
  );

  it('preserves Tool Broker ownership instead of assigning it to a harness', () => {
    const event: HarnessEvent = {
      ...envelope('dsh'),
      type: 'tool.completed',
      toolCallId: 'call-1',
      name: 'workspace.file.read',
      label: '读取工作区文件',
      source: 'tool_broker',
      summary: '1 file',
    };
    expect(normalizeHarnessRunEvent(event)).toMatchObject({
      type: 'tool.completed',
      payload: {
        source: 'tool_broker',
        status: 'completed',
        toolCallId: 'call-1',
      },
    });
  });

  it('keeps usage as a first-class ChatFlow event and preserves source metadata', () => {
    const event: HarnessEvent = {
      ...envelope('codex'),
      sourceEventId: 'codex-native-9',
      sourceEventType: 'turn.completed',
      sourceOccurredAt: '2026-08-25T12:00:00.000Z',
      type: 'usage.updated',
      inputTokens: 120,
      cachedInputTokens: 40,
      outputTokens: 20,
    };
    expect(normalizeHarnessRunEvent(event)).toEqual({
      type: 'usage.updated',
      payload: expect.objectContaining({
        source: 'codex',
        sourceEventId: 'codex-native-9',
        sourceEventType: 'turn.completed',
        sourceOccurredAt: '2026-08-25T12:00:00.000Z',
        usage: {
          inputTokens: 120,
          cachedInputTokens: 40,
          outputTokens: 20,
        },
      }),
    });
  });

  it('preserves a sanitized DSH-native presentation event', () => {
    const event: HarnessEvent = {
      ...envelope('dsh'),
      sourceEventId: 'dsh:12',
      sourceEventType: 'request/context',
      sourceOccurredAt: '2026-08-27T12:00:00.000Z',
      sourcePayload: { provider: 'openai-codex', model: 'gpt-5.6-luna' },
      type: 'native.event',
      presentation: 'context',
      status: 'info',
      label: '模型上下文',
      summary: 'openai-codex · gpt-5.6-luna',
    };
    expect(normalizeHarnessRunEvent(event)).toMatchObject({
      type: 'harness.native',
      payload: {
        source: 'dsh',
        presentation: 'context',
        label: '模型上下文',
        nativePayload: {
          provider: 'openai-codex',
          model: 'gpt-5.6-luna',
        },
      },
    });
  });
});
