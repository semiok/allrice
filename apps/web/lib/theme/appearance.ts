// The employee's appearance choice in the browser. The server-rendered
// appearance script writes it to <html data-appearance> before the first
// paint, only on signed-in workspace pages; without it a page keeps its
// surface default. Settings, the preferences read and a page coming back to
// the foreground update it here, and the theme follows.
import type { Appearance } from '@allrice/contracts';
import { applyTheme, themeConfig, themeFor } from './theme';

const attribute = 'data-appearance';
const listeners = new Set<() => void>();

export function currentAppearance() {
  return document.documentElement.getAttribute(attribute);
}

export function applyCurrentTheme(pathname = location.pathname) {
  applyTheme(themeFor(pathname, currentAppearance(), themeConfig).theme);
}

export function setAppearance(choice: Appearance) {
  if (currentAppearance() !== choice) {
    document.documentElement.setAttribute(attribute, choice);
    for (const listener of listeners) listener();
  }
  applyCurrentTheme();
}

export function subscribeAppearance(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reads the saved choice again. DSH re-reads on a settings push or a
 * reconnect; AllRice has no push, so a page re-reads when it comes back to
 * the foreground. A failed read keeps the current choice. */
export async function reloadAppearance() {
  if (currentAppearance() === null) return;
  try {
    const response = await fetch('/api/v1/me/preferences', {
      cache: 'no-store',
    });
    if (!response.ok) return;
    const body: { preferences?: { appearance?: unknown } } =
      await response.json();
    const choice = body.preferences?.appearance;
    if (choice === 'light' || choice === 'dark' || choice === 'system')
      setAppearance(choice);
  } catch {
    // Offline or signed out: the page keeps what it shows.
  }
}
