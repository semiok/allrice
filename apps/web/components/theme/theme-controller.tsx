'use client';

import { useLayoutEffect } from 'react';
import { usePathname } from 'next/navigation';
import {
  applyTheme,
  storedThemePreference,
  themeConfig,
  themeFor,
} from '../../lib/theme/theme';

/** Keeps the theme right after the first paint: client navigation between
 * surfaces (before the new page paints) and another tab changing the stored
 * choice. Any failure leaves the current theme. */
export function useThemeSync(pathname: string) {
  useLayoutEffect(() => {
    const apply = () => {
      try {
        const { surface } = themeFor(pathname, null, themeConfig);
        applyTheme(
          themeFor(pathname, storedThemePreference(surface), themeConfig).theme,
        );
      } catch {
        // Keep whatever theme is showing; never break the page over it.
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith(themeConfig.storagePrefix))
        apply();
    };
    apply();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [pathname]);
}

export function ThemeController() {
  useThemeSync(usePathname());
  return null;
}
