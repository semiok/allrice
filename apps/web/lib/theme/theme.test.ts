import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readTenantTheme,
  setTenantTheme,
  themeConfig,
  themeFor,
} from './theme';
import { themeScript } from './theme-script';

function element(map: Map<string, string>) {
  return {
    getAttribute: (name: string) => map.get(name) ?? null,
    setAttribute: (name: string, value: string) => map.set(name, value),
    removeAttribute: (name: string) => map.delete(name),
  };
}

describe('theme selection', () => {
  it('defaults the workspace to light and the admin console to dark', () => {
    expect(themeFor('/chatflow', null, themeConfig)).toEqual({
      surface: 'tenant',
      theme: 'light',
    });
    expect(themeFor('/runtime-console', null, themeConfig)).toEqual({
      surface: 'admin',
      theme: 'dark',
    });
    expect(themeFor('/runtime-console/x', null, themeConfig).surface).toBe(
      'admin',
    );
    // Brand pages stay light on the admin host; lookalike paths are tenant.
    expect(themeFor('/login', null, themeConfig).theme).toBe('light');
    expect(themeFor('/runtime-consoles', null, themeConfig).surface).toBe(
      'tenant',
    );
  });

  it('honours a stored choice and treats anything else as no choice', () => {
    expect(themeFor('/runtime-console', 'light', themeConfig).theme).toBe(
      'light',
    );
    expect(themeFor('/chatflow', 'dark', themeConfig).theme).toBe('dark');
    for (const stored of ['system', 'purple', ''])
      expect(themeFor('/chatflow', stored, themeConfig).theme).toBe('light');
  });

  // The inline script runs alone, before any bundle: execute it against
  // bare globals, including the ones a private window takes away.
  function run(
    pathname: string,
    stored: Record<string, string>,
    storage: 'ok' | 'throws' = 'ok',
  ) {
    const attributes = { html: new Map(), body: new Map() };
    const matchMedia = vi.fn(() => ({ matches: true }));
    runInNewContext(themeScript, {
      location: { pathname },
      localStorage: {
        getItem: (key: string) => {
          if (storage === 'throws') throw Error('SecurityError');
          return stored[key] ?? null;
        },
      },
      matchMedia,
      document: {
        documentElement: element(attributes.html),
        body: element(attributes.body),
      },
    });
    // A dark system is on offer every time and never consulted.
    expect(matchMedia).not.toHaveBeenCalled();
    return {
      theme: attributes.html.get('data-theme'),
      dark: attributes.body.has('data-ds-dark-theme'),
    };
  }

  it('runs as a self-contained script before the first paint', () => {
    expect(run('/chatflow', {})).toEqual({ theme: 'light', dark: false });
    expect(run('/runtime-console', {})).toEqual({ theme: 'dark', dark: true });
    expect(run('/runtime-console', { 'allrice.theme.admin': 'light' })).toEqual(
      { theme: 'light', dark: false },
    );
    expect(run('/chatflow', { 'allrice.theme.tenant': 'dark' })).toEqual({
      theme: 'dark',
      dark: true,
    });
    expect(run('/chatflow', { 'allrice.theme.tenant': 'system' })).toEqual({
      theme: 'light',
      dark: false,
    });
    // Blocked storage falls back to the default.
    expect(run('/runtime-console', {}, 'throws')).toEqual({
      theme: 'dark',
      dark: true,
    });
  });
});

describe('the workspace theme switch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function page(pathname: string, storage: 'ok' | 'throws' = 'ok') {
    const stored = new Map<string, string>();
    const attributes = { html: new Map(), body: new Map() };
    vi.stubGlobal('location', { pathname });
    vi.stubGlobal('document', {
      documentElement: element(attributes.html),
      body: element(attributes.body),
    });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => {
        if (storage === 'throws') throw Error('SecurityError');
        return stored.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (storage === 'throws') throw Error('SecurityError');
        stored.set(key, value);
      },
    });
    return {
      stored,
      dark: () => attributes.body.has('data-ds-dark-theme'),
    };
  }

  it('reads light until a choice is saved, then saves and shows it', () => {
    const tab = page('/chatflow');
    expect(readTenantTheme()).toBe('light');
    expect(setTenantTheme('dark')).toBe(true);
    expect(tab.stored.get('allrice.theme.tenant')).toBe('dark');
    expect(tab.dark()).toBe(true);
    expect(readTenantTheme()).toBe('dark');
    expect(setTenantTheme('light')).toBe(true);
    expect(tab.dark()).toBe(false);
    expect(readTenantTheme()).toBe('light');
  });

  it('saves without repainting an admin page', () => {
    const tab = page('/runtime-console');
    expect(setTenantTheme('dark')).toBe(true);
    expect(tab.stored.get('allrice.theme.tenant')).toBe('dark');
    expect(tab.dark()).toBe(false);
  });

  it('keeps a choice the browser refuses to store for this tab', () => {
    const tab = page('/chatflow', 'throws');
    expect(setTenantTheme('dark')).toBe(false);
    expect(tab.dark()).toBe(true);
    expect(readTenantTheme()).toBe('dark');
    // Once storage works again, the saved choice takes over.
    const next = page('/chatflow');
    expect(setTenantTheme('light')).toBe(true);
    expect(next.stored.get('allrice.theme.tenant')).toBe('light');
    expect(readTenantTheme()).toBe('light');
  });
});
