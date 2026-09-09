import { describe, expect, it } from 'vitest';
import { browserGrantOriginDenial } from './browser-control-origin.ts';

describe('ordinary browser grant public-origin preflight (no DNS)', () => {
  it.each([
    'https://127.0.0.1',
    'https://127.1',
    'https://2130706433',
    'https://0x7f000001',
    'https://10.2.3.4',
    'https://100.64.0.1',
    'https://169.254.169.254',
    'https://172.16.1.1',
    'https://192.168.1.1',
    'https://192.0.2.1',
    'https://198.18.0.1',
    'https://203.0.113.1',
    'https://224.0.0.1',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[fc00::1]',
    'https://[fe80::1]',
    'https://[2001:db8::1]',
    'https://[2002:7f00:1::]',
    'https://localhost',
    'https://LOCALHOST.',
    'https://host.local.',
    'https://host.internal',
    'https://host.test',
    'https://host.onion',
    'https://intranet',
    'http://example.com',
    'https://example.com:8443',
    'https://user:secret@example.com',
  ])('rejects %s before storing an authorization', (origin) => {
    expect(browserGrantOriginDenial(origin)).toBe(
      'browser_public_origin_required',
    );
  });
  it.each([
    'https://preview.allrice.invalid',
    'https://p-123.preview.allrice.invalid.',
  ])('keeps the dedicated preview capability separate: %s', (origin) => {
    expect(browserGrantOriginDenial(origin)).toBe(
      'browser_reserved_origin_denied',
    );
  });
  it.each([
    'https://example.com',
    'https://8.8.8.8',
    'https://[2606:4700:4700::1111]',
  ])(
    'accepts public syntax without asserting DNS availability: %s',
    (origin) => {
      expect(browserGrantOriginDenial(origin)).toBeNull();
    },
  );
});
