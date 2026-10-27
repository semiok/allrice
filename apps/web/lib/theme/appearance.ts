// The employee's appearance choice in the browser. On workspace pages the
// server-rendered appearance script writes it to <html data-appearance>
// before the first paint, with the account in data-appearance-viewer; other
// pages keep their surface default. Settings, the preferences read and a page
// coming back to the foreground update it here, and the theme follows.
import type { Appearance } from '@allrice/contracts';
import { applyTheme, themeConfig, themeFor } from './theme';

const attribute = 'data-appearance';
const viewerAttribute = 'data-appearance-viewer';
const listeners = new Set<() => void>();
// Bumped by every read and change, so an earlier read cannot undo a newer
// read or choice (DSH ui-theme drops stale syncs by revision the same way).
let version = 0;

export function currentAppearance() {
  return document.documentElement.getAttribute(attribute);
}

export function applyCurrentTheme(pathname = location.pathname) {
  applyTheme(themeFor(pathname, currentAppearance(), themeConfig).theme);
}

export function setAppearance(choice: Appearance) {
  version += 1;
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

/** Reads the saved choice again on a workspace page, also one whose first
 * read failed. DSH re-reads on a settings push or a reconnect; AllRice has no
 * push, so a page re-reads when it comes back to the foreground. A failed
 * read keeps the current choice. */
export async function reloadAppearance() {
  const viewer = document.documentElement.getAttribute(viewerAttribute);
  if (viewer === null) return;
  version += 1;
  const started = version;
  try {
    const response = await fetch('/api/v1/me/preferences', {
      cache: 'no-store',
    });
    if (!response.ok) return;
    const body: { viewerId?: unknown; preferences?: { appearance?: unknown } } =
      await response.json();
    // A newer read or choice came meanwhile, or another account signed in here.
    if (version !== started || (viewer && body.viewerId !== viewer)) return;
    const choice = body.preferences?.appearance;
    if (choice === 'light' || choice === 'dark' || choice === 'system')
      setAppearance(choice);
  } catch {
    // Offline or signed out: the page keeps what it shows.
  }
}
