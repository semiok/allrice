'use client';

import '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect } from 'react';

export function FocusController() {
  useEffect(() => {
    // DSH owns pointer/navigation tracking. Escape can close a popover while
    // focus stays on its trigger, so no focusin publishes keyboard modality.
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing)
        document.documentElement.setAttribute(
          'data-input-modality',
          'keyboard',
        );
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, []);
  return null;
}
