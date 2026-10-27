// Light or dark is one switch: DSH's body[data-ds-dark-theme], which DSH's
// --dsw-* aliases (and AllRice's --ar-* tokens in packages/ui tokens.css)
// follow. html[data-theme] mirrors it for color-scheme and for code that
// watches <html> (terminal-workbench.tsx, tool-file-diff.tsx).
// Each surface has a fixed default, the tenant workspace light and the admin
// console dark (MET-214); the system theme is never read. Only a person's
// choice, saved in this browser per surface, changes it (user, 10-27).
// Login and invitation pages count as tenant on every host: they are brand
// pages. Surfaces are told apart by path; adding a Next basePath means adding
// it to adminPaths too (location.pathname keeps it).

export type Theme = 'light' | 'dark';
export type ThemeSurface = 'tenant' | 'admin';

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
  config: ThemeConfig,
) {
  let surface: ThemeSurface = 'tenant';
  for (let i = 0; i < config.adminPaths.length; i += 1) {
    const path = config.adminPaths[i]!;
    if (pathname === path || pathname.indexOf(path + '/') === 0)
      surface = 'admin';
  }
  const theme: Theme =
    stored === 'light' || stored === 'dark' ? stored : config.defaults[surface];
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

// A choice the browser refused to store still holds in this tab until it
// reloads, so a client navigation does not undo it.
const unsaved: Partial<Record<ThemeSurface, Theme>> = {};

export function storedThemePreference(surface: ThemeSurface) {
  if (unsaved[surface]) return unsaved[surface];
  try {
    return localStorage.getItem(themeConfig.storagePrefix + surface);
  } catch {
    return null;
  }
}

/** The employee workspace's theme in this browser: the person's saved
 * choice, else light. It reads browser storage, so call it after mount (in
 * an effect or an event handler), never while rendering on the server. */
export function readTenantTheme(): Theme {
  const stored = storedThemePreference('tenant');
  return stored === 'light' || stored === 'dark'
    ? stored
    : themeConfig.defaults.tenant;
}

/** Saves the employee workspace's theme in this browser and switches to it
 * at once when this page is part of the workspace; other open tabs follow
 * through the storage event. Returns false when the browser refuses to store
 * it: the choice then holds in this tab only, until it reloads. */
export function setTenantTheme(theme: Theme): boolean {
  let saved = true;
  try {
    localStorage.setItem(themeConfig.storagePrefix + 'tenant', theme);
    delete unsaved.tenant;
  } catch {
    unsaved.tenant = theme;
    saved = false;
  }
  if (themeFor(location.pathname, null, themeConfig).surface === 'tenant')
    applyTheme(theme);
  return saved;
}
