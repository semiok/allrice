import { describe, expect, it } from 'vitest';

import { dshEgressEnvironment } from './dsh-egress-environment.js';

describe('dshEgressEnvironment', () => {
  it('does not inherit ambient host proxy variables', () => {
    expect(
      dshEgressEnvironment({
        HTTP_PROXY: 'http://ambient.example:8080',
        HTTPS_PROXY: 'http://ambient.example:8080',
      }),
    ).toEqual({});
  });

  it('maps explicitly approved DSH proxy settings into the child', () => {
    expect(
      dshEgressEnvironment({
        ALLRICE_DSH_HTTP_PROXY: 'http://127.0.0.1:7897',
        ALLRICE_DSH_HTTPS_PROXY: 'http://127.0.0.1:7897',
        ALLRICE_DSH_NO_PROXY: 'localhost,127.0.0.1',
      }),
    ).toEqual({
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: 'localhost,127.0.0.1',
    });
  });

  it('rejects unsupported or relative proxy URLs without echoing them', () => {
    expect(() =>
      dshEgressEnvironment({
        ALLRICE_DSH_HTTPS_PROXY: 'socks5://secret@localhost:1080',
      }),
    ).toThrow('ALLRICE_DSH_HTTPS_PROXY must use the http or https protocol');
    expect(() =>
      dshEgressEnvironment({ ALLRICE_DSH_HTTP_PROXY: 'localhost:7897' }),
    ).toThrow('ALLRICE_DSH_HTTP_PROXY must be an absolute HTTP(S) proxy URL');
  });
});
