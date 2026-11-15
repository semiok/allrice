'use client';

import { useEffect, useState, type RefCallback } from 'react';

/** Attach through DSH's public scrollport ref; native zoom and scrolling stay owned by DSH. */
export function useNativePreviewGestures({
  roundHeight = false,
}: { roundHeight?: boolean } = {}): RefCallback<HTMLElement> {
  const [scrollport, setScrollport] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!scrollport) return;
    const node = scrollport;
    const height = node.style.getPropertyValue('height');
    const heightPriority = node.style.getPropertyPriority('height');
    // Approved <1px image-only adjustment: fractional viewport heights can
    // leave Chromium's native scroll chain stuck at its rounded inner edge.
    if (roundHeight) node.style.setProperty('height', 'round(down, 100%, 1px)');
    let drag:
      | { id: number; x: number; y: number; left: number; top: number }
      | undefined;
    const wheel = (event: WheelEvent) => {
      // Chromium pinch is already Ctrl+wheel. Route Command+wheel through
      // that same native path, including its anchoring and settled preference.
      if (!event.metaKey || event.ctrlKey || event.defaultPrevented) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      (event.target instanceof Element ? event.target : node).dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
          deltaMode: event.deltaMode,
          clientX: event.clientX,
          clientY: event.clientY,
        }),
      );
    };
    const down = (event: PointerEvent) => {
      if (
        event.defaultPrevented ||
        event.pointerType !== 'mouse' ||
        event.button !== 0
      )
        return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Preserve native text selection and document/footer controls.
      if (
        target.closest(
          'a, button, input, textarea, select, [contenteditable="true"]',
        )
      )
        return;
      if (
        Array.from(target.childNodes).some(
          (child) =>
            child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
        )
      )
        return;
      if (
        node.scrollWidth <= node.clientWidth &&
        node.scrollHeight <= node.clientHeight
      )
        return;
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: node.scrollLeft,
        top: node.scrollTop,
      };
      node.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      node.scrollLeft = drag.left + drag.x - event.clientX;
      node.scrollTop = drag.top + drag.y - event.clientY;
      event.preventDefault();
    };
    const end = () => {
      if (drag && node.hasPointerCapture(drag.id))
        node.releasePointerCapture(drag.id);
      drag = undefined;
    };
    node.addEventListener('wheel', wheel, { capture: true, passive: false });
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
    node.addEventListener('lostpointercapture', end);
    return () => {
      end();
      if (roundHeight) {
        if (height) node.style.setProperty('height', height, heightPriority);
        else node.style.removeProperty('height');
      }
      node.removeEventListener('wheel', wheel, true);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', end);
      node.removeEventListener('lostpointercapture', end);
    };
  }, [scrollport, roundHeight]);
  return setScrollport;
}
