'use client';

import { useEffect, useLayoutEffect } from 'react';
import { usePathname } from 'next/navigation';
import {
  applyCurrentTheme,
  currentAppearance,
  reloadAppearance,
} from '../../lib/theme/appearance';

/** Keeps the theme right after the first paint: a client navigation between
 * the workspace and the admin console switches it before the new page
 * paints; with "follow system" the workspace follows the system's light or
 * dark; a page coming back to the foreground re-reads the saved choice. */
export function useThemeSync(pathname: string) {
  useLayoutEffect(() => {
    applyCurrentTheme(pathname);
  }, [pathname]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const system = () => {
      if (currentAppearance() === 'system') applyCurrentTheme();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void reloadAppearance();
    };
    media.addEventListener('change', system);
    document.addEventListener('visibilitychange', visible);
    return () => {
      media.removeEventListener('change', system);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
}

export function ThemeController() {
  useThemeSync(usePathname());
  return null;
}
