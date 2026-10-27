// Light or dark is one switch: DSH's body[data-ds-dark-theme], which DSH's
// --dsw-* aliases (and AllRice's --ar-* tokens in packages/ui tokens.css)
// follow. html[data-theme] mirrors it for color-scheme and for code that
// watches <html> (terminal-workbench.tsx, tool-file-diff.tsx).
// Each surface has a fixed default, the tenant workspace light and the admin
// console dark (MET-214); the system theme is never read. A person's choice
// will come from their preferences on the server (/api/v1/me/preferences,
// user 10-27, a separate PR); until then every caller passes null.
// Login and invitation pages count as tenant on every host: they are brand
// pages. Surfaces are told apart by path; adding a Next basePath means adding
// it to adminPaths too (location.pathname keeps it).

export type Theme = 'light' | 'dark';
export type ThemeSurface = 'tenant' | 'admin';

export interface ThemeConfig {
  adminPaths: string[];
  defaults: Record<ThemeSurface, Theme>;
}

export const themeConfig: ThemeConfig = {
  adminPaths: ['/runtime-console'],
  defaults: { tenant: 'light', admin: 'dark' },
};

// themeFor and applyTheme also run in the pre-paint inline script
// (theme-script.ts) through Function.prototype.toString: keep them
// self-contained (no imports, no module-level names) and free of syntax that
// needs compiler helpers.
export function themeFor(
  pathname: string,
  choice: string | null,
  config: ThemeConfig,
) {
  let surface: ThemeSurface = 'tenant';
  for (let i = 0; i < config.adminPaths.length; i += 1) {
    const path = config.adminPaths[i]!;
    if (pathname === path || pathname.indexOf(path + '/') === 0)
      surface = 'admin';
  }
  const theme: Theme =
    choice === 'light' || choice === 'dark' ? choice : config.defaults[surface];
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
