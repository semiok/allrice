// Imported only by the root layout (a server component), so the string and
// its builder never ship to the browser.
import { applyTheme, themeConfig, themeFor, type ThemeConfig } from './theme';

// Reads the stored choice, which may be unavailable, and applies the theme
// before the first paint. The system theme plays no part.
function bootstrap(
  config: ThemeConfig,
  resolve: typeof themeFor,
  apply: typeof applyTheme,
) {
  const path = location.pathname;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(
      config.storagePrefix + resolve(path, null, config).surface,
    );
  } catch {
    // Private windows and blocked storage fall back to the surface default.
  }
  apply(resolve(path, stored, config).theme);
}

/** Runs at the top of <body>, before any content paints. Server-only: the
 * client keeps the theme with ThemeController. */
export const themeScript = `(${bootstrap.toString()})(${JSON.stringify(themeConfig)},${themeFor.toString()},${applyTheme.toString()})`;
