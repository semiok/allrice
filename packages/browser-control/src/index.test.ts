import { describe, expect, it } from 'vitest';
import { browserObservationUrl } from './index.js';

describe('browser observation URL', () => {
  it('preserves the empty isolated page without inventing a null origin', () => {
    expect(browserObservationUrl('about:blank')).toBe('about:blank');
  });

  it('only displays HTTP origins and paths without credentials, query or hash', () => {
    expect(
      browserObservationUrl(
        'https://user:secret@example.com/login?token=secret#secret',
      ),
    ).toBe('https://example.com/login');
    expect(browserObservationUrl('http://127.0.0.1:3000/status?q=secret')).toBe(
      'http://127.0.0.1:3000/status',
    );
  });

  it('does not expose non-web URL contents', () => {
    for (const value of [
      'file:///private/secret',
      'data:text/plain,secret',
      'javascript:secret()',
      'not a URL',
    ]) {
      expect(browserObservationUrl(value)).toBe('about:blank');
    }
  });
});
