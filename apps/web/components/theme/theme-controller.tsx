'use client';

import { useLayoutEffect } from 'react';
import { usePathname } from 'next/navigation';
import {
  applyTheme,
  storedThemePreference,
  themeConfig,
  themeFor,
} from '../../lib/theme/theme';

function systemTheme() {
  try {
    return matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return null;
  }
}

/** Keeps the theme right after the first paint: client navigation between
 * surfaces (before the new page paints), another tab changing the stored
 * choice, and the system theme. Any failure leaves the current theme. */
export function useThemeSync(pathname: string) {
  useLayoutEffect(() => {
    const media = systemTheme();
    const apply = () => {
      try {
        const { surface } = themeFor(pathname, null, false, themeConfig);
        applyTheme(
          themeFor(
            pathname,
            storedThemePreference(surface),
            media?.matches ?? false,
            themeConfig,
          ).theme,
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
    media?.addEventListener?.('change', apply);
    window.addEventListener('storage', onStorage);
    return () => {
      media?.removeEventListener?.('change', apply);
      window.removeEventListener('storage', onStorage);
    };
  }, [pathname]);
}

export function ThemeController() {
  useThemeSync(usePathname());
  return null;
}
