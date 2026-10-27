// Imported only by server components (the root layout and AppearanceScript),
// so the string and its builder never ship to the browser.
import type { Appearance } from '@allrice/contracts';
import { applyTheme, themeConfig, themeFor, type ThemeConfig } from './theme';

// Applies the theme before the first paint. A signed-in workspace page also
// passes the employee's saved choice, which stays on <html data-appearance>
// for the client (lib/theme/appearance.ts).
function bootstrap(
  config: ThemeConfig,
  resolve: typeof themeFor,
  apply: typeof applyTheme,
  choice: string | null,
) {
  if (choice !== null)
    document.documentElement.setAttribute('data-appearance', choice);
  apply(resolve(location.pathname, choice, config).theme);
}

const script = (choice: Appearance | null) =>
  `(${bootstrap.toString()})(${JSON.stringify(themeConfig)},${themeFor.toString()},${applyTheme.toString()},${JSON.stringify(choice)})`;

/** Runs at the top of <body>, before any content paints: the surface default.
 * Server-only: the client keeps the theme with ThemeController. */
export const themeScript = script(null);

/** Runs next on signed-in workspace pages, still before any content paints. */
export const appearanceScript = (choice: Appearance) => script(choice);
