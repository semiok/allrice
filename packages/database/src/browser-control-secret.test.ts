import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  sealBrowserDirectInput,
  openBrowserDirectInput,
  type BrowserSecretScope,
} from './browser-control-secret.ts';
const key = '63'.repeat(32),
  secret = 'Synthetic-only-password';
const scope = (): BrowserSecretScope => ({
  organizationId: randomUUID(),
  tenantWorkspaceId: randomUUID(),
  browserWorkspaceId: randomUUID(),
  profileId: randomUUID(),
  actorId: randomUUID(),
  inputId: randomUUID(),
  fence: 1,
  observationId: randomUUID(),
  elementId: 'e1',
  expiresAt: new Date(5000).toISOString(),
});
describe('short lived purpose-bound direct input', () => {
  it('encrypts with random nonce and decrypts only matching purpose/scope', () => {
    const s = scope(),
      a = sealBrowserDirectInput(secret, s, key),
      b = sealBrowserDirectInput(secret, s, key);
    expect(a).not.toEqual(b);
    expect(JSON.stringify(a)).not.toContain(secret);
    const bytes = openBrowserDirectInput(a, s, 1000, key);
    expect(bytes.toString()).toBe(secret);
    bytes.fill(0);
    for (const field of Object.keys(s) as (keyof BrowserSecretScope)[]) {
      const changed = { ...s, [field]: field === 'fence' ? 2 : randomUUID() };
      expect(() => openBrowserDirectInput(a, changed, 1000, key)).toThrow(
        'BROWSER_DIRECT_INPUT_UNAVAILABLE',
      );
    }
  });
  it('expiry, tamper, wrong/missing key fail closed without secret/cause', () => {
    const s = scope(),
      a = sealBrowserDirectInput(secret, s, key);
    for (const run of [
      () => openBrowserDirectInput(a, s, 5000, key),
      () =>
        openBrowserDirectInput({ ...a, tag: '00'.repeat(16) }, s, 1000, key),
      () => openBrowserDirectInput(a, s, 1000, '01'.repeat(32)),
      () => sealBrowserDirectInput(secret, s, ''),
    ]) {
      try {
        run();
        throw Error('unexpected success');
      } catch (e) {
        expect((e as Error).message).toBe('BROWSER_DIRECT_INPUT_UNAVAILABLE');
        expect((e as Error).cause).toBeUndefined();
      }
    }
    expect(() => sealBrowserDirectInput('bad\0value', s, key)).toThrow(
      'BROWSER_DIRECT_INPUT_INVALID',
    );
  });
});
