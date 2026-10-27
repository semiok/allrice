// Light or dark is one switch: DSH's body[data-ds-dark-theme], which DSH's
// --dsw-* aliases (and AllRice's --ar-* tokens in packages/ui tokens.css)
// follow. html[data-theme] mirrors it for color-scheme and for code that
// watches <html> (terminal-workbench.tsx, tool-file-diff.tsx).
// Each surface has a fixed default, the tenant workspace light and the admin
// console dark (MET-214). On the workspace an employee may choose light, dark
// or system (DSH ui-theme preference values, saved in their preferences on
// the server, user 10-27); the admin console always stays dark.
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
  // Signed in, the server sends the saved choice, whose default is the
  // contract's defaultUserPreferences.appearance. The tenant default here only
  // covers pages without one (signed out, or the read failed). It cannot
  // import the contract: themeFor runs in the inline script, and this module
  // is in every page's bundle. theme.test.ts keeps the two equal.
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
  let theme: Theme = config.defaults[surface];
  if (surface === 'tenant') {
    if (choice === 'light' || choice === 'dark') theme = choice;
    // As DSH ui-theme resolves `system`: from prefers-color-scheme.
    else if (choice === 'system' && typeof matchMedia !== 'undefined')
      theme = matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  }
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
