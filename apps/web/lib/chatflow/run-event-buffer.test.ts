import { describe, expect, it } from 'vitest';

import type { ChatFlowEventEnvelope } from '@allrice/contracts';

import { mergeChatFlowEvents } from './run-event-buffer';

function event(id: string, sequence: number): ChatFlowEventEnvelope {
  return {
    schemaVersion: 3,
    eventId: id,
    organizationId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    conversationId: null,
    runId: '33333333-3333-4333-8333-333333333333',
    generation: 1,
    cursor: `33333333-3333-4333-8333-333333333333:${sequence}`,
    sequence,
    harness: 'dsh',
    type: 'harness.native',
    occurredAt: `2026-08-29T03:03:${String(sequence).padStart(2, '0')}.000Z`,
    sourceEvent: null,
    payload: { label: id },
  };
}

describe('mergeChatFlowEvents', () => {
  it('keeps the richer live timeline when a stale snapshot is empty', () => {
    const live = [event('one', 1), event('two', 2)];
    expect(mergeChatFlowEvents(live, [])).toEqual(live);
  });

  it('deduplicates replayed events and appends new events in sequence order', () => {
    expect(
      mergeChatFlowEvents(
        [event('one', 1), event('three', 3)],
        [event('two', 2), event('three', 3)],
      ).map((item) => item.eventId),
    ).toEqual(['one', 'two', 'three']);
  });
});
