import { describe, expect, it } from 'vitest';
import { themeConfig, themeFor, themeScript } from './theme';

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

  it('builds a self-contained inline script', () => {
    // No module-level names may leak into the stringified functions.
    expect(() => new Function(themeScript)).not.toThrow();
    expect(themeScript).not.toMatch(
      /themeConfig|storedThemePreference|_[a-z]+\(/,
    );
  });
});
