import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePortal } from './config';
import {
  createPortalSession,
  verifyPortalCredentials,
  verifyPortalSession,
} from './session';

describe('host-bound bootstrap portals', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.ALLRICE_PORTAL_SESSION_SECRET =
      'test-secret-with-at-least-thirty-two-characters';
    process.env.ALLRICE_SNOW_PASSWORD = 'snow-test-password';
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('resolves known hosts and rejects an untrusted host', () => {
    expect(resolvePortal('allrice-admin.bplabs.xyz')?.key).toBe(
      'platform-admin',
    );
    expect(resolvePortal('allrice-dsh.bplabs.xyz')?.key).toBe(
      'runtime-console',
    );
    expect(resolvePortal('allrice-snow.bplabs.xyz')?.key).toBe('snow');
    expect(resolvePortal('allrice-drink.bplabs.xyz')).toBeNull();
    expect(resolvePortal('dsh.bplabs.xyz')).toBeNull();
    expect(resolvePortal('attacker.invalid')).toBeNull();
  });

  it('accepts only the credential assigned to the resolved portal', () => {
    const snow = resolvePortal('allrice-snow.bplabs.xyz');
    expect(snow).not.toBeNull();
    expect(verifyPortalCredentials(snow!, 'snow', 'snow-test-password')).toBe(
      true,
    );
    expect(verifyPortalCredentials(snow!, 'drink', 'snow-test-password')).toBe(
      false,
    );
  });

  it('binds a signed session to one portal', () => {
    const snow = resolvePortal('allrice-snow.bplabs.xyz')!;
    const platform = resolvePortal('allrice-admin.bplabs.xyz')!;
    const issued = createPortalSession({
      portal: snow,
      subject: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      workspaceId: '33333333-3333-4333-8333-333333333333',
    });

    expect(verifyPortalSession(issued.value, snow)?.portalKey).toBe('snow');
    expect(verifyPortalSession(issued.value, platform)).toBeNull();
    expect(verifyPortalSession(`${issued.value}tampered`, snow)).toBeNull();
  });
});
