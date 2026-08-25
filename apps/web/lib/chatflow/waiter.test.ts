import { describe, expect, it } from 'vitest';

import { createChatFlowWaiter } from './waiter.ts';

describe('ChatFlow waiter', () => {
  it('does not lose a signal delivered before a waiter is attached', async () => {
    const waiter = createChatFlowWaiter();
    waiter.signal();
    await expect(waiter.wait(100, new AbortController().signal)).resolves.toBe(
      'signal',
    );
  });

  it('keeps a safety timeout for PostgreSQL reconnect gaps', async () => {
    const waiter = createChatFlowWaiter();
    await expect(waiter.wait(1, new AbortController().signal)).resolves.toBe(
      'timeout',
    );
  });
});
