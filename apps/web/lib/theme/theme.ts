// Light or dark is one switch: DSH's body[data-ds-dark-theme], which DSH's
// --dsw-* aliases (and AllRice's --ar-* tokens in packages/ui tokens.css)
// follow. html[data-theme] mirrors it for color-scheme and for code that
// watches <html> (terminal-workbench.tsx, tool-file-diff.tsx).
// The tenant workspace defaults to light and the admin console to dark
// (MET-214). Login and invitation pages count as tenant on every host:
// they are brand pages. Surfaces are told apart by path; adding a Next
// basePath means adding it to adminPaths too (location.pathname keeps it).

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

// themeFor and applyTheme also run in the pre-paint inline script
// (theme-script.ts) through Function.prototype.toString: keep them
// self-contained (no imports, no module-level names) and free of syntax that
// needs compiler helpers.
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
  const html = document.documentElement;
  // Unchanged attributes are left alone: the terminal and diff views watch
  // <html> and repaint on every mutation.
  if (html.getAttribute('data-theme') !== theme)
    html.setAttribute('data-theme', theme);
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
