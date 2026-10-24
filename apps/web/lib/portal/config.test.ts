import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isUnifiedPortalHost,
  legacyPortalNavigation,
  normalizeHost,
  portalAccountKind,
  resolvePortal,
  tenantTrialPortal,
} from './config';
import { portalEntries } from '../../server/portal-hosts.mjs';

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
    expect(normalizeHost('[2001:DB8:0::1]:8443')).toBe('2001:db8::1');
    // Equivalent spellings of one address are one host.
    vi.stubEnv(
      'ALLRICE_EMPLOYEE_PORTAL_HOSTS',
      '[2001:db8::1]:8443,::ffff:1.2.3.4',
    );
    for (const host of [
      '[2001:0db8:0:0:0:0:0:1]:8443',
      '[2001:DB8::1]',
      '[::ffff:1.2.3.4]',
      '[::ffff:102:304]',
    ])
      expect(portalAccountKind(host)).toBe('employee');
    expect(portalAccountKind('a.bplabs.xyz/x')).toBeUndefined();
  });
  it('matches no entry for a Host that is not strictly host[:port]', () => {
    vi.stubEnv('ALLRICE_EMPLOYEE_PORTAL_HOSTS', 'rice.example.com');
    vi.stubEnv('ALLRICE_ADMIN_PORTAL_HOSTS', '');
    for (const host of [
      '@allrice-admin.bplabs.xyz',
      'allrice-admin.bplabs.xyz/path/..',
      'u:p@allrice-admin.bplabs.xyz',
    ])
      expect(resolvePortal(host)).toBeNull();
    for (const host of ['allrice.bplabs.xyz/path/..', '@allrice.bplabs.xyz'])
      expect(isUnifiedPortalHost(host)).toBe(false);
    // Other IPv4 spellings are not the loopback entry.
    for (const host of ['0x7f.1', '127.1', '2130706433'])
      expect(isUnifiedPortalHost(host)).toBe(false);
    // Whitespace before the port and bare IPv6 are not a Host; every check agrees.
    for (const host of [
      'allrice.bplabs.xyz :443',
      'allrice.bplabs.xyz\t:443',
      'rice.example.com :443',
      'allrice.bplabs.xyz:',
      '::1',
      '2001:db8::1',
    ]) {
      expect(normalizeHost(host)).toBe('');
      expect(isUnifiedPortalHost(host)).toBe(false);
      expect(resolvePortal(host)).toBeNull();
      expect(portalAccountKind(host)).toBeUndefined();
    }
    // Wherever a Host opens the shared entry, it is held to employee accounts.
    for (const host of [
      'allrice.bplabs.xyz',
      'ALLRICE.bplabs.xyz:443',
      ' rice.example.com:8443 ',
      'rice.example.com,evil.test',
      'allrice-admin.bplabs.xyz',
      'allrice-snow.bplabs.xyz',
    ])
      if (isUnifiedPortalHost(host))
        expect(portalAccountKind(host)).toBe('employee');
  });
  it('refuses malformed and conflicting entries', () => {
    for (const bad of [
      'rice.example.com/path',
      'rice.example.com/path/..',
      'https://rice.example.com',
      'u@rice.example.com',
      '@rice.example.com',
      '*.example.com',
      'rice.example.com:0',
      'rice.example.com:70000',
      '[2001:db8::g]',
      '999.1.1.1',
      '127.1',
      'localhost:3000',
      '127.0.0.1',
      '[::1]',
    ]) {
      vi.stubEnv('ALLRICE_EMPLOYEE_PORTAL_HOSTS', bad);
      expect(() => isUnifiedPortalHost('rice.example.com')).toThrow(
        /ALLRICE_EMPLOYEE_PORTAL_HOSTS/,
      );
    }
    expect(() =>
      portalEntries({
        ALLRICE_EMPLOYEE_PORTAL_HOSTS: 'a.bplabs.xyz',
        ALLRICE_ADMIN_PORTAL_HOSTS: 'A.bplabs.xyz:8443',
      }),
    ).toThrow(/a\.bplabs\.xyz/);
    // Built-in entries count on both sides.
    for (const env of [
      { ALLRICE_ADMIN_PORTAL_HOSTS: 'allrice.bplabs.xyz' },
      { ALLRICE_EMPLOYEE_PORTAL_HOSTS: 'allrice-admin.bplabs.xyz' },
      { ALLRICE_EMPLOYEE_PORTAL_HOSTS: 'allrice-dsh.traditionow.ai' },
    ])
      expect(() => portalEntries(env)).toThrow(/both employee and admin/);
    // A conflicting list refuses requests too, whatever started the server.
    vi.stubEnv('ALLRICE_EMPLOYEE_PORTAL_HOSTS', 'allrice-admin.bplabs.xyz');
    expect(() => portalAccountKind('allrice-admin.bplabs.xyz')).toThrow();
    expect(() =>
      portalEntries({
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
