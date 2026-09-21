import { describe, it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';
import { boundToolResult } from '../tool-broker/result-budget.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';

describe('native web_search uses the bounded Broker result', () => {
  it('returns bounded search data to the real pinned DSH loop; rejects invalid queries before Broker', async () => {
    await nativeBrokerRoundtrip({
      canonicalName: 'web.search',
      wireName: 'web_search',
      args: { queries: ['fixture query'] },
      brokerArgs: { query: 'fixture query', maxResults: 5 },
      invalidArgs: { queries: [] },
      onToolCall: (call) =>
        boundToolResult({ call } as RiceToolExecutionInput, {
          modelContent: JSON.stringify({
            output: 'Search source text. '.repeat(3000),
          }),
          summary: 'Synthetic search result; no external request',
        }),
    });
  }, 30_000);
});
