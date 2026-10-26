'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import {
  applyTheme,
  storedThemePreference,
  themeConfig,
  themeFor,
} from '../../lib/theme/theme';

/** Keeps the theme right after the first paint: client navigation between
 * surfaces, another tab changing the stored choice, and the system theme. */
export function useThemeSync(pathname: string) {
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const { surface } = themeFor(pathname, null, false, themeConfig);
      applyTheme(
        themeFor(
          pathname,
          storedThemePreference(surface),
          media.matches,
          themeConfig,
        ).theme,
      );
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith(themeConfig.storagePrefix))
        apply();
    };
    apply();
    media.addEventListener('change', apply);
    window.addEventListener('storage', onStorage);
    return () => {
      media.removeEventListener('change', apply);
      window.removeEventListener('storage', onStorage);
    };
  }, [pathname]);
}

export function ThemeController() {
  useThemeSync(usePathname());
  return null;
}
