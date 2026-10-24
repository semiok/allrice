import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isUnifiedPortalHost,
  legacyPortalNavigation,
  normalizeHost,
  portalAccountKind,
  resolvePortal,
  tenantTrialPortal,
} from './config';
import { checkPortalHostConfiguration } from '../../server/portal-hosts.mjs';

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
  });
  it('matches IPv6 and ported entries and links to them as configured', () => {
    vi.stubEnv(
      'ALLRICE_EMPLOYEE_PORTAL_HOSTS',
      '2001:db8::1,[2001:db8::2]:8443',
    );
    for (const host of ['[2001:db8::1]', '[2001:db8::1]:443', '[2001:db8::2]'])
      expect(portalAccountKind(host)).toBe('employee');
    expect(tenantTrialPortal('acme', 'https://example.test')).toBe(
      'https://[2001:db8::1]/chatflow',
    );
    vi.stubEnv('ALLRICE_EMPLOYEE_PORTAL_HOSTS', 'rice.example.com:8443');
    expect(portalAccountKind('rice.example.com')).toBe('employee');
    expect(tenantTrialPortal('acme', 'https://example.test')).toBe(
      'https://rice.example.com:8443/chatflow',
    );
    for (const value of ['[2001:db8::1]:8443', 'A.b:443', '[::1]', '::1'])
      expect(normalizeHost(normalizeHost(value))).toBe(normalizeHost(value));
  });
  it('refuses malformed and conflicting entries', () => {
    for (const bad of [
      'rice.example.com/path',
      'https://rice.example.com',
      'u@rice.example.com',
    ]) {
      vi.stubEnv('ALLRICE_EMPLOYEE_PORTAL_HOSTS', bad);
      expect(() => isUnifiedPortalHost('rice.example.com')).toThrow(
        /ALLRICE_EMPLOYEE_PORTAL_HOSTS/,
      );
    }
    expect(() =>
      checkPortalHostConfiguration({
        ALLRICE_EMPLOYEE_PORTAL_HOSTS: 'a.bplabs.xyz',
        ALLRICE_ADMIN_PORTAL_HOSTS: 'A.bplabs.xyz:8443',
      }),
    ).toThrow(/a\.bplabs\.xyz/);
    expect(() =>
      checkPortalHostConfiguration({
        ALLRICE_ADMIN_PORTAL_HOSTS: 'allrice.bplabs.xyz',
      }),
    ).toThrow();
    expect(() =>
      checkPortalHostConfiguration({
        ALLRICE_EMPLOYEE_PORTAL_HOSTS: 'a.bplabs.xyz',
        ALLRICE_ADMIN_PORTAL_HOSTS: 'a-admin.bplabs.xyz',
      }),
    ).not.toThrow();
  });
  it('moves legacy aliases to the entries this deployment configures', () => {
    vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '1');
    vi.stubEnv('ALLRICE_EMPLOYEE_PORTAL_HOSTS', 'a.bplabs.xyz');
    vi.stubEnv('ALLRICE_ADMIN_PORTAL_HOSTS', 'a-admin.bplabs.xyz:8443');
    const move = (host: string, path = '/chatflow?session=kept') =>
      legacyPortalNavigation({
        url: `https://${host}${path}`,
        method: 'GET',
        headers: new Headers({ host }),
      })?.href ?? null;
    expect(move('allrice-snow.bplabs.xyz')).toBe(
      'https://a.bplabs.xyz/chatflow?session=kept',
    );
    expect(move('allrice-dsh.bplabs.xyz', '/runtime-console')).toBe(
      'https://a-admin.bplabs.xyz:8443/runtime-console',
    );
    // An alias the deployment lists as its own entry is served, not moved.
    vi.stubEnv(
      'ALLRICE_ADMIN_PORTAL_HOSTS',
      'a-admin.bplabs.xyz,allrice-dsh.bplabs.xyz',
    );
    expect(move('allrice-dsh.bplabs.xyz', '/runtime-console')).toBeNull();
  });
});
