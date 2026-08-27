import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalizeRunEvent,
  harnessCapabilityMatrix,
  type HarnessCapabilities,
  type RunEvent,
} from './index.ts';

function runEvent(
  type: RunEvent['type'],
  payload: Record<string, unknown>,
): RunEvent {
  return {
    eventId: randomUUID(),
    runId: randomUUID(),
    sequence: 0,
    type,
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    payload,
  };
}

describe('AllRice Runtime Contract V1', () => {
  it.each(['codex', 'dsh'] as const)(
    'normalizes %s assistant events without exposing its wire protocol',
    (source) => {
      const event = canonicalizeRunEvent(
        runEvent('assistant.text.delta', {
          source,
          text: 'hello',
          generation: 3,
          privateWireField: { ignoredByPresentation: true },
        }),
      );
      expect(event).toMatchObject({
        type: 'assistant.text.delta',
        category: 'assistant',
        phase: 'running',
        harness: source,
        generation: 3,
      });
    },
  );

  it('gives tool, approval and context events stable presentation states', () => {
    expect(canonicalizeRunEvent(runEvent('tool.completed', {}))).toMatchObject({
      category: 'tool',
      phase: 'succeeded',
    });
    expect(
      canonicalizeRunEvent(runEvent('approval.requested', {})),
    ).toMatchObject({ category: 'approval', phase: 'waiting' });
    expect(
      canonicalizeRunEvent(runEvent('context.compaction.failed', {})),
    ).toMatchObject({ category: 'context', phase: 'failed' });
  });

  it('publishes a product-facing matrix without granting authorization', () => {
    const capabilities: HarnessCapabilities = {
      persistentThreads: true,
      assistantDeltas: true,
      toolEvents: true,
      usageEvents: true,
      interrupt: false,
      steer: false,
      compact: true,
      recover: true,
    };
    expect(harnessCapabilityMatrix(capabilities)).toEqual({
      persistent_threads: true,
      assistant_streaming: true,
      tool_events: true,
      usage_events: true,
      interrupt: false,
      active_turn_steer: false,
      context_compaction: true,
      thread_recovery: true,
    });
  });
});
