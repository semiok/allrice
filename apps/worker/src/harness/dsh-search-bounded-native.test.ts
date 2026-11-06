import { describe, it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';
import { boundToolResult } from '../tool-broker/result-budget.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';

describe('native web_search owns rendering and count limits', () => {
  it('returns uncropped search data to the real pinned DSH loop; rejects invalid queries before Broker', async () => {
    await nativeBrokerRoundtrip({
      canonicalName: 'web.search',
      wireName: 'web_search',
      args: { queries: ['fixture query'] },
      brokerArgs: { query: 'fixture query', maxResults: 8 },
      invalidArgs: { queries: [] },
      modelResultIncludes: 'Search source text. '.repeat(3000),
      onToolCall: (call) =>
        boundToolResult({ call } as RiceToolExecutionInput, {
          modelContent: JSON.stringify({
            content: 'Search source text. '.repeat(3000),
            sources: [
              { url: 'https://example.com/source', publishedAt: '2026-11-05' },
            ],
            truncated: false,
          }),
          summary: 'Synthetic search result; no external request',
        }),
    });
  }, 30_000);
});
