// Imported only by the root layout (a server component), so the string and
// its builder never ship to the browser.
import { applyTheme, themeConfig, themeFor, type ThemeConfig } from './theme';

// Reads the stored choice and the system theme, both of which may be
// unavailable, and applies the theme before the first paint.
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

/** Runs at the top of <body>, before any content paints. Server-only: the
 * client keeps the theme with ThemeController. */
export const themeScript = `(${bootstrap.toString()})(${JSON.stringify(themeConfig)},${themeFor.toString()},${applyTheme.toString()})`;
