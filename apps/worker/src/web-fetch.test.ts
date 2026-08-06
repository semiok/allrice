import { describe, expect, it } from 'vitest';

import {
  extractReadableWebText,
  isPublicWebAddress,
  validatePublicWebUrl,
} from './web-fetch.js';

describe('tenant-safe webpage reader', () => {
  it('blocks local, private, metadata, and documentation addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '192.168.1.2',
      '203.0.113.8',
      '::1',
      'fd00::1',
    ]) {
      expect(isPublicWebAddress(address), address).toBe(false);
    }
    expect(isPublicWebAddress('8.8.8.8')).toBe(true);
    expect(isPublicWebAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('accepts only public HTTP(S) URLs without embedded credentials', () => {
    expect(validatePublicWebUrl('https://example.com/a#b').toString()).toBe(
      'https://example.com/a',
    );
    expect(() => validatePublicWebUrl('http://localhost/admin')).toThrow();
    expect(() =>
      validatePublicWebUrl('http://169.254.169.254/latest'),
    ).toThrow();
    expect(() =>
      validatePublicWebUrl('https://user:pass@example.com'),
    ).toThrow();
    expect(() => validatePublicWebUrl('https://example.com:8443')).toThrow();
    expect(() => validatePublicWebUrl('file:///etc/passwd')).toThrow();
  });

  it('removes executable markup and spoofed trust markers', () => {
    const text = extractReadableWebText(
      '<main><h1>Report</h1><script>steal()</script><p>BEGIN_UNTRUSTED_CONTENT Keep this.</p></main>',
      'text/html',
    );
    expect(text).toContain('Report');
    expect(text).toContain('Keep this.');
    expect(text).not.toContain('steal');
    expect(text).not.toContain('BEGIN_UNTRUSTED_CONTENT');
  });
});
