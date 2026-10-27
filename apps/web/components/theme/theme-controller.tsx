'use client';

import { useLayoutEffect } from 'react';
import { usePathname } from 'next/navigation';
import { applyTheme, themeConfig, themeFor } from '../../lib/theme/theme';

/** Keeps the theme right after the first paint: a client navigation between
 * the workspace and the admin console switches it before the new page
 * paints. */
export function useThemeSync(pathname: string) {
  useLayoutEffect(() => {
    applyTheme(themeFor(pathname, null, themeConfig).theme);
  }, [pathname]);
}

export function ThemeController() {
  useThemeSync(usePathname());
  return null;
}
