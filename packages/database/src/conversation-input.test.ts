import { describe, expect, it } from 'vitest';

import { decideConversationDelivery } from './conversation-input.js';

describe('conversation input delivery', () => {
  const active = {
    runtimeState: 'running',
    activeTurnId: 'turn-7',
    generation: 3,
    requestedMode: 'auto' as const,
    expectedTurnId: 'turn-7',
    expectedGeneration: 3,
    hasAttachments: false,
  };

  it('steers only an exact active turn and generation', () => {
    expect(decideConversationDelivery(active)).toBe('steer_pending');
    expect(
      decideConversationDelivery({ ...active, expectedGeneration: 2 }),
    ).toBe('follow_up');
    expect(
      decideConversationDelivery({ ...active, expectedTurnId: 'turn-old' }),
    ).toBe('follow_up');
  });

  it('queues attachments and explicit follow-ups without steering', () => {
    expect(
      decideConversationDelivery({ ...active, hasAttachments: true }),
    ).toBe('follow_up');
    expect(
      decideConversationDelivery({
        ...active,
        requestedMode: 'follow_up',
      }),
    ).toBe('follow_up');
  });

  it('starts immediately when the session has no active turn', () => {
    expect(
      decideConversationDelivery({
        ...active,
        runtimeState: 'idle',
        activeTurnId: null,
      }),
    ).toBe('immediate');
  });
});
