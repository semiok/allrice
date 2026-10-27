import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { defaultUserPreferences } from '@allrice/contracts';
import { themeConfig, themeFor } from './theme';
import { appearanceScript, themeScript } from './theme-script';

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

  it('uses the contract default for workspace pages without a saved choice', () => {
    expect(themeConfig.defaults.tenant).toBe(defaultUserPreferences.appearance);
  });

  it('honours the workspace choice, resolves system and treats anything else as no choice', () => {
    expect(themeFor('/chatflow', 'dark', themeConfig).theme).toBe('dark');
    expect(themeFor('/workspace/mcp', 'light', themeConfig).theme).toBe(
      'light',
    );
    for (const choice of ['purple', '', 'Dark', null])
      expect(themeFor('/chatflow', choice, themeConfig).theme).toBe('light');
    for (const dark of [true, false]) {
      vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({ matches: dark })),
      );
      expect(themeFor('/chatflow', 'system', themeConfig).theme).toBe(
        dark ? 'dark' : 'light',
      );
      expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    }
    vi.unstubAllGlobals();
    // Without matchMedia (no browser), system keeps the workspace default.
    expect(themeFor('/chatflow', 'system', themeConfig).theme).toBe('light');
  });

  it('keeps the admin console dark whatever the employee chose', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    );
    for (const choice of ['light', 'dark', 'system', null])
      expect(themeFor('/runtime-console/x', choice, themeConfig)).toEqual({
        surface: 'admin',
        theme: 'dark',
      });
    vi.unstubAllGlobals();
  });

  // The inline script runs alone, before any bundle: execute it against
  // bare globals. There is no localStorage here, so touching it would throw.
  function run(pathname: string, script = themeScript, systemDark = true) {
    const attributes = { html: new Map(), body: new Map() };
    const matchMedia = vi.fn(() => ({ matches: systemDark }));
    runInNewContext(script, {
      location: { pathname },
      matchMedia,
      document: {
        documentElement: element(attributes.html),
        body: element(attributes.body),
      },
    });
    return {
      theme: attributes.html.get('data-theme'),
      dark: attributes.body.has('data-ds-dark-theme'),
      appearance: attributes.html.get('data-appearance'),
      viewer: attributes.html.get('data-appearance-viewer'),
      system: matchMedia.mock.calls.length > 0,
    };
  }

  it('runs as a self-contained script before the first paint', () => {
    // Without a saved choice a dark system is on offer and never consulted.
    expect(run('/chatflow')).toEqual({
      theme: 'light',
      dark: false,
      appearance: undefined,
      viewer: undefined,
      system: false,
    });
    expect(run('/runtime-console')).toEqual({
      theme: 'dark',
      dark: true,
      appearance: undefined,
      viewer: undefined,
      system: false,
    });
  });

  it('paints the saved choice first and leaves it for the client', () => {
    const saved = (choice: 'light' | 'dark' | 'system') =>
      appearanceScript({ choice, viewer: 'viewer-a' });
    expect(run('/chatflow', saved('dark'))).toEqual({
      theme: 'dark',
      dark: true,
      appearance: 'dark',
      viewer: 'viewer-a',
      system: false,
    });
    expect(run('/chatflow', saved('light'))).toMatchObject({
      theme: 'light',
      dark: false,
      appearance: 'light',
    });
    for (const systemDark of [true, false])
      expect(run('/automation', saved('system'), systemDark)).toEqual({
        theme: systemDark ? 'dark' : 'light',
        dark: systemDark,
        appearance: 'system',
        viewer: 'viewer-a',
        system: true,
      });
    expect(run('/runtime-console', saved('light'))).toMatchObject({
      theme: 'dark',
      dark: true,
    });
  });

  it('marks a workspace page whose read failed, keeping the default', () => {
    expect(
      run('/automation', appearanceScript({ choice: null, viewer: null })),
    ).toEqual({
      theme: 'light',
      dark: false,
      appearance: undefined,
      viewer: '',
      system: false,
    });
    expect(
      run('/chatflow', appearanceScript({ choice: null, viewer: 'viewer-a' })),
    ).toMatchObject({
      theme: 'light',
      appearance: undefined,
      viewer: 'viewer-a',
    });
  });
});
