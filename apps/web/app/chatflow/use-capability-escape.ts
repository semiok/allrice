'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  isBehindModal,
  modalSelector,
  observeComposition,
} from '@deepseek-ai/dsh-client-ui-primitives';

/** Inline capability pages yield to native modal ownership and use the same
 * public composition guard as Modal, without registering another modal layer. */
export function useCapabilityEscape(
  elementRef: RefObject<HTMLElement | null>,
  active: boolean,
  onBack: () => void,
) {
  const back = useRef(onBack);
  back.current = onBack;
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!active || !element) return;
    const document = element.ownerDocument;
    const composition = observeComposition(document);
    const keydown = (event: KeyboardEvent) => {
      const composing = composition.guards(event);
      const foreground = [...document.querySelectorAll(modalSelector)].at(-1);
      if (
        event.defaultPrevented ||
        composing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        isBehindModal(element) ||
        (foreground && !foreground.contains(element))
      )
        return;
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) back.current();
      }
    };
    element.addEventListener('keydown', keydown);
    return () => {
      composition.dispose();
      element.removeEventListener('keydown', keydown);
    };
  }, [active, elementRef]);
}
