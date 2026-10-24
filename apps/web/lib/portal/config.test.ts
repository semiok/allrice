import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isUnifiedPortalHost,
  portalAccountKind,
  resolvePortal,
  tenantTrialPortal,
} from './config';
import { loginDestination } from './login-destination';

afterEach(() => vi.unstubAllEnvs());

describe('portal hosts', () => {
  it('keeps the built-in hosts when nothing is configured', () => {
    vi.stubEnv('ALLRICE_EMPLOYEE_PORTAL_HOSTS', '');
    vi.stubEnv('ALLRICE_ADMIN_PORTAL_HOSTS', '');
    expect(isUnifiedPortalHost('allrice.bplabs.xyz')).toBe(true);
    expect(resolvePortal('allrice-admin.bplabs.xyz')?.key).toBe(
      'runtime-console',
    );
    expect(resolvePortal('a.bplabs.xyz')).toBeNull();
    expect(isUnifiedPortalHost('a.bplabs.xyz')).toBe(false);
    expect(tenantTrialPortal('acme', 'https://allrice-admin.bplabs.xyz')).toBe(
      'https://allrice.bplabs.xyz/chatflow',
    );
  });
  it('serves a deployment from its own employee and admin domains', () => {
    vi.stubEnv(
      'ALLRICE_EMPLOYEE_PORTAL_HOSTS',
      ' A.bplabs.xyz ,rice.example.com',
    );
    vi.stubEnv('ALLRICE_ADMIN_PORTAL_HOSTS', 'a-admin.bplabs.xyz');
    expect(isUnifiedPortalHost('a.bplabs.xyz:443')).toBe(true);
    expect(isUnifiedPortalHost('rice.example.com')).toBe(true);
    expect(portalAccountKind('a.bplabs.xyz')).toBe('employee');
    expect(resolvePortal('a-admin.bplabs.xyz')?.key).toBe('runtime-console');
    expect(portalAccountKind('a-admin.bplabs.xyz')).toBe('platform_admin');
    expect(resolvePortal('b.bplabs.xyz')).toBeNull();
    expect(tenantTrialPortal('acme', 'https://a-admin.bplabs.xyz')).toBe(
      'https://a.bplabs.xyz/chatflow',
    );
    // The employee entry still never navigates into the admin console.
    expect(
      loginDestination('/runtime-console', '/chatflow', 'https://a.bplabs.xyz'),
    ).toBe('/chatflow');
  });
});
