import { describe, expect, it } from 'vitest';

import { conversationRuntimeCanAcquire } from './conversation-runtime.js';

describe('durable conversation runtime ownership', () => {
  it('allows idle sessions and retries of the same run', () => {
    expect(
      conversationRuntimeCanAcquire({
        state: 'idle',
        activeRunId: null,
        requestedRunId: 'run-2',
        activeRunTerminal: false,
      }),
    ).toBe(true);
    expect(
      conversationRuntimeCanAcquire({
        state: 'running',
        activeRunId: 'run-1',
        requestedRunId: 'run-1',
        activeRunTerminal: false,
      }),
    ).toBe(true);
  });

  it('rejects a second live run but recovers terminal ownership', () => {
    expect(
      conversationRuntimeCanAcquire({
        state: 'running',
        activeRunId: 'run-1',
        requestedRunId: 'run-2',
        activeRunTerminal: false,
      }),
    ).toBe(false);
    expect(
      conversationRuntimeCanAcquire({
        state: 'running',
        activeRunId: 'run-1',
        requestedRunId: 'run-2',
        activeRunTerminal: true,
      }),
    ).toBe(true);
  });
});
