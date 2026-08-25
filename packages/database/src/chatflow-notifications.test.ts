import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseChatFlowWakeup } from './chatflow-notifications.ts';

describe('ChatFlow PostgreSQL wakeups', () => {
  it('parses the small transport-neutral notification', () => {
    const runId = randomUUID();
    expect(
      parseChatFlowWakeup(JSON.stringify({ runId, sequence: 12 })),
    ).toEqual({ runId, sequence: 12 });
  });

  it('rejects wakeups that try to carry a durable payload', () => {
    expect(() =>
      parseChatFlowWakeup(
        JSON.stringify({ runId: randomUUID(), sequence: 1, text: 'leak' }),
      ),
    ).toThrow();
  });
});
