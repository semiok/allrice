import { it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('exposes public page reading to the native DSH loop and rejects an empty URL before the Broker', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'web.fetch',
    wireName: 'web_fetch',
    args: { url: 'https://example.com/article' },
    invalidArgs: { url: '' },
    invalidResultIncludes: 'url',
    modelResultIncludes: 'native page text',
    onToolCall: async () => ({
      modelContent: JSON.stringify({
        url: 'https://example.com/article',
        statusCode: 200,
        body: { kind: 'text', content: 'native page text' },
        truncated: false,
      }),
      summary: 'fixture',
    }),
  });
}, 30_000);
