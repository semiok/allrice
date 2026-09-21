import { afterEach, expect, it, vi } from 'vitest';
import { releaseHeaders } from './release-headers';
afterEach(() => vi.unstubAllEnvs());
it('exposes only an explicitly configured immutable release SHA', () => {
  vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
  expect(releaseHeaders()).toEqual({ 'X-AllRice-Release-Sha': 'a'.repeat(40) });
  for (const value of [undefined, '', 'main', 'dirty', 'secret\r\nheader']) {
    vi.stubEnv('ALLRICE_RELEASE_SHA', value);
    expect(releaseHeaders()).toEqual({});
  }
});
