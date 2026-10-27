// Imported only by server components (the root layout and AppearanceScript),
// so the string and its builder never ship to the browser.
import type { Appearance } from '@allrice/contracts';
import { applyTheme, themeConfig, themeFor, type ThemeConfig } from './theme';

/** What a signed-in workspace page knows on the server: the employee's saved
 * choice and account, either null when the read failed or nobody is signed in. */
export interface WorkspaceAppearance {
  choice: Appearance | null;
  viewer: string | null;
}

// Applies the theme before the first paint. On a workspace page it also
// leaves the saved choice and the account on <html> for the client
// (lib/theme/appearance.ts); the account attribute marks a workspace page even
// when the read failed, so the page still re-reads later.
function bootstrap(
  config: ThemeConfig,
  resolve: typeof themeFor,
  apply: typeof applyTheme,
  workspace: WorkspaceAppearance | null,
) {
  const html = document.documentElement;
  let choice: string | null = null;
  if (workspace !== null) {
    html.setAttribute('data-appearance-viewer', workspace.viewer || '');
    if (workspace.choice !== null) {
      choice = workspace.choice;
      html.setAttribute('data-appearance', choice);
    }
  }
  apply(resolve(location.pathname, choice, config).theme);
}

const script = (workspace: WorkspaceAppearance | null) =>
  `(${bootstrap.toString()})(${JSON.stringify(themeConfig)},${themeFor.toString()},${applyTheme.toString()},${JSON.stringify(workspace)})`;

/** Runs at the top of <body>, before any content paints: the surface default.
 * Server-only: the client keeps the theme with ThemeController. */
export const themeScript = script(null);

/** Runs next on workspace pages, still before any content paints. */
export const appearanceScript = (workspace: WorkspaceAppearance) =>
  script(workspace);
