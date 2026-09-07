import { describe, it, expect } from 'vitest';
import { sameOriginBrowserWrite } from './request-origin';
describe('cookie-authenticated runtime writes', () => {
  it('accepts the actual HTTPS Host across a local reverse proxy', () => {
    expect(
      sameOriginBrowserWrite(
        new Request('http://localhost:3001/api', {
          headers: { host: 'tenant.example', origin: 'https://tenant.example' },
        }),
      ),
    ).toBe(true);
  });
  it.each([
    {},
    { origin: 'null' },
    { origin: 'https://attacker.example' },
    {
      origin: 'https://attacker.example',
      'x-forwarded-host': 'attacker.example',
    },
    { origin: 'https://tenant.example', 'sec-fetch-site': 'cross-site' },
    { origin: 'http://tenant.example' },
  ])('denies missing, cross-site and forged forwarding origins', (headers) => {
    expect(
      sameOriginBrowserWrite(
        new Request('http://localhost:3001/api', {
          headers: Object.fromEntries(
            Object.entries({ ...headers, host: 'tenant.example' }).filter(
              (pair): pair is [string, string] => typeof pair[1] === 'string',
            ),
          ),
        }),
      ),
    ).toBe(false);
  });
});
