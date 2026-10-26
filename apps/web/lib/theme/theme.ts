// Light or dark is one switch: DSH's body[data-ds-dark-theme], which every
// --dsw-* and --ar-* token follows. html[data-theme] mirrors it for
// color-scheme and for code that watches <html> (terminal-workbench.tsx).
// The tenant workspace defaults to light and the admin console to dark
// (MET-214). Login and invitation pages count as tenant on every host:
// they are brand pages.

export type Theme = 'light' | 'dark';
export type ThemeSurface = 'tenant' | 'admin';
export type ThemePreference = Theme | 'system';

export interface ThemeConfig {
  adminPaths: string[];
  defaults: Record<ThemeSurface, Theme>;
  storagePrefix: string;
}

export const themeConfig: ThemeConfig = {
  adminPaths: ['/runtime-console'],
  defaults: { tenant: 'light', admin: 'dark' },
  storagePrefix: 'allrice.theme.',
};

// themeFor, applyTheme and bootstrap also run as the pre-paint inline script,
// through Function.prototype.toString: keep them self-contained (no imports,
// no module-level names) and free of syntax that needs compiler helpers.
export function themeFor(
  pathname: string,
  stored: string | null,
  systemDark: boolean,
  config: ThemeConfig,
) {
  let surface: ThemeSurface = 'tenant';
  for (let i = 0; i < config.adminPaths.length; i += 1) {
    const path = config.adminPaths[i]!;
    if (pathname === path || pathname.indexOf(path + '/') === 0)
      surface = 'admin';
  }
  const theme: Theme =
    stored === 'light' || stored === 'dark'
      ? stored
      : stored === 'system'
        ? systemDark
          ? 'dark'
          : 'light'
        : config.defaults[surface];
  return { surface, theme };
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // A presence selector: light must remove it, not set it to "false".
  if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
  else document.body.removeAttribute('data-ds-dark-theme');
}

export function storedThemePreference(surface: ThemeSurface) {
  try {
    return localStorage.getItem(themeConfig.storagePrefix + surface);
  } catch {
    return null;
  }
}

function bootstrap(
  config: ThemeConfig,
  resolve: typeof themeFor,
  apply: typeof applyTheme,
) {
  const path = location.pathname;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(
      config.storagePrefix + resolve(path, null, false, config).surface,
    );
  } catch {
    // Private windows and blocked storage fall back to the surface default.
  }
  let systemDark = false;
  try {
    systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    // Without media queries the system counts as light.
  }
  apply(resolve(path, stored, systemDark, config).theme);
}

/** Runs at the top of <body>, before any content paints. */
export const themeScript = `(${bootstrap.toString()})(${JSON.stringify(themeConfig)},${themeFor.toString()},${applyTheme.toString()})`;
