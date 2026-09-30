import { it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('exposes public page reading to the native DSH loop and rejects non-HTTP URLs before the Broker', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'web.fetch',
    wireName: 'web_fetch',
    args: { url: 'https://example.com/article' },
    invalidArgs: { url: 'file:///private/local.txt' },
    invalidResultIncludes: 'web_fetch_http_url_required',
  });
}, 30_000);
