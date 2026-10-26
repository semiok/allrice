import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { themeConfig, themeFor } from './theme';
import { themeScript } from './theme-script';

describe('theme selection', () => {
  it('defaults the workspace to light and the admin console to dark', () => {
    expect(themeFor('/chatflow', null, true, themeConfig)).toEqual({
      surface: 'tenant',
      theme: 'light',
    });
    expect(themeFor('/runtime-console', null, false, themeConfig)).toEqual({
      surface: 'admin',
      theme: 'dark',
    });
    expect(
      themeFor('/runtime-console/x', null, false, themeConfig).surface,
    ).toBe('admin');
    // Brand pages stay light on the admin host; lookalike paths are tenant.
    expect(themeFor('/login', null, false, themeConfig).theme).toBe('light');
    expect(
      themeFor('/runtime-consoles', null, false, themeConfig).surface,
    ).toBe('tenant');
  });

  it('honours a stored choice and follows the system only when asked', () => {
    expect(themeFor('/runtime-console', 'light', true, themeConfig).theme).toBe(
      'light',
    );
    expect(themeFor('/chatflow', 'dark', false, themeConfig).theme).toBe(
      'dark',
    );
    expect(themeFor('/chatflow', 'system', true, themeConfig).theme).toBe(
      'dark',
    );
    expect(themeFor('/chatflow', 'system', false, themeConfig).theme).toBe(
      'light',
    );
    expect(themeFor('/chatflow', 'purple', true, themeConfig).theme).toBe(
      'light',
    );
  });

  // The inline script runs alone, before any bundle: execute it against
  // bare globals, including the ones a private window takes away.
  function run(
    pathname: string,
    stored: Record<string, string>,
    systemDark: boolean | 'throws',
    storage: 'ok' | 'throws' = 'ok',
  ) {
    const attributes = { html: new Map(), body: new Map() };
    const element = (map: Map<string, string>) => ({
      getAttribute: (name: string) => map.get(name) ?? null,
      setAttribute: (name: string, value: string) => map.set(name, value),
      removeAttribute: (name: string) => map.delete(name),
    });
    runInNewContext(themeScript, {
      location: { pathname },
      localStorage: {
        getItem: (key: string) => {
          if (storage === 'throws') throw Error('SecurityError');
          return stored[key] ?? null;
        },
      },
      matchMedia: () => {
        if (systemDark === 'throws') throw Error('unsupported');
        return { matches: systemDark };
      },
      document: {
        documentElement: element(attributes.html),
        body: element(attributes.body),
      },
    });
    return {
      theme: attributes.html.get('data-theme'),
      dark: attributes.body.has('data-ds-dark-theme'),
    };
  }

  it('runs as a self-contained script before the first paint', () => {
    expect(run('/chatflow', {}, true)).toEqual({ theme: 'light', dark: false });
    expect(run('/runtime-console', {}, false)).toEqual({
      theme: 'dark',
      dark: true,
    });
    expect(
      run('/runtime-console', { 'allrice.theme.admin': 'light' }, false),
    ).toEqual({ theme: 'light', dark: false });
    expect(
      run('/chatflow', { 'allrice.theme.tenant': 'system' }, true),
    ).toEqual({ theme: 'dark', dark: true });
    // Blocked storage or missing media queries fall back to the default.
    expect(run('/runtime-console', {}, 'throws', 'throws')).toEqual({
      theme: 'dark',
      dark: true,
    });
  });
});
