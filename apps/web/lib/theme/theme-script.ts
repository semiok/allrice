// Imported only by the root layout (a server component), so the string and
// its builder never ship to the browser.
import { applyTheme, themeConfig, themeFor, type ThemeConfig } from './theme';

// Applies the surface's default before the first paint. The system theme
// plays no part.
function bootstrap(
  config: ThemeConfig,
  resolve: typeof themeFor,
  apply: typeof applyTheme,
) {
  apply(resolve(location.pathname, null, config).theme);
}

/** Runs at the top of <body>, before any content paints. Server-only: the
 * client keeps the theme with ThemeController. */
export const themeScript = `(${bootstrap.toString()})(${JSON.stringify(themeConfig)},${themeFor.toString()},${applyTheme.toString()})`;
