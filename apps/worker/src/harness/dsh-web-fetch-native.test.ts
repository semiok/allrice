import { it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('exposes public page reading to the native DSH loop and rejects non-HTTP URLs before the Broker', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'web.fetch',
    wireName: 'web_fetch',
    args: { url: 'https://example.com/article' },
    invalidArgs: { url: 'file:///private/local.txt' },
    invalidResultIncludes: 'http',
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
