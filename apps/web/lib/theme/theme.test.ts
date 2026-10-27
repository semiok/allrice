import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { themeConfig, themeFor } from './theme';
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

  it('honours a light or dark choice and treats anything else as no choice', () => {
    expect(themeFor('/runtime-console', 'light', themeConfig).theme).toBe(
      'light',
    );
    expect(themeFor('/chatflow', 'dark', themeConfig).theme).toBe('dark');
    for (const choice of ['system', 'purple', ''])
      expect(themeFor('/chatflow', choice, themeConfig).theme).toBe('light');
  });

  // The inline script runs alone, before any bundle: execute it against
  // bare globals. There is no localStorage here, so touching it would throw.
  function run(pathname: string) {
    const attributes = { html: new Map(), body: new Map() };
    const matchMedia = vi.fn(() => ({ matches: true }));
    runInNewContext(themeScript, {
      location: { pathname },
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
    expect(run('/chatflow')).toEqual({ theme: 'light', dark: false });
    expect(run('/runtime-console')).toEqual({ theme: 'dark', dark: true });
  });
});
