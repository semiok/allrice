'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import frameUi from './dsh-upstream/AppFrame.module.css';
import styles from './workbench.module.css';

/**
 * Adapted from DSH AppFrame.tsx, MIT, b150a551b8d465e31e418e1b2eaf5e79bbb7d28e:
 * packages/client/ui-layout/src/client/AppFrame.tsx (DragHandle + frame observer).
 * Reuses native pointer capture, rAF throttling, frozen drag origin and handle CSS.
 * Allrice adds scoped preferences, cancellation cleanup, keyboard access and reset.
 */
export function useWorkbenchResize(
  preference: number | null,
  sidebarWidth = 240,
) {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ frame: 0, viewport: 0 });
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!frame) return;
    let raf: number | null = null;
    const measure = () => {
      raf = null;
      setSize({
        frame: frame.getBoundingClientRect().width,
        viewport: window.innerWidth,
      });
    };
    const schedule = () => {
      raf ??= requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(frame);
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [frame]);
  const min = 340;
  const max = Math.max(
    min,
    Math.round(Math.min(size.frame - sidebarWidth - 340, size.viewport * 0.8)),
  );
  const width = Math.min(
    max,
    Math.max(min, Math.round(preference ?? size.frame * 0.38)),
  );
  return { frameRef: setFrame, width, min, max, dragging, setDragging };
}

export function WorkbenchSplitter({
  width,
  min,
  max,
  onChange,
  onDraggingChange,
}: {
  width: number;
  min: number;
  max: number;
  onChange: (width: number | null) => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0),
    latest = useRef(0),
    base = useRef(0);
  const frame = useRef<number | null>(null);
  const callbacks = useRef({ onChange, onDraggingChange, width, min, max });
  callbacks.current = { onChange, onDraggingChange, width, min, max };
  const apply = useCallback((next: number) => {
    const { onChange, min, max } = callbacks.current;
    onChange(Math.min(max, Math.max(min, Math.round(next))));
  }, []);
  const stop = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    setDragging(false);
    callbacks.current.onDraggingChange(false);
  }, []);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      callbacks.current.onDraggingChange(false);
    },
    [],
  );
  return (
    <div
      className={`${frameUi.handle} ${styles.splitter}`}
      style={{ left: `calc(100% - ${width}px)` }}
      data-side="details"
      data-dragging={dragging || undefined}
      role="separator"
      aria-label="调整交付成果宽度"
      aria-orientation="vertical"
      aria-controls="artifact-workbench"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} 像素`}
      tabIndex={0}
      title="拖动调整宽度；双击恢复默认。也可使用左右方向键，按 Home 恢复默认。"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        origin.current = latest.current = event.clientX;
        // Read the rendered box, including any in-flight grid transition.
        base.current =
          document.getElementById('artifact-workbench')?.getBoundingClientRect()
            .width ?? width;
        setDragging(true);
        onDraggingChange(true);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        latest.current = event.clientX;
        frame.current ??= requestAnimationFrame(() => {
          frame.current = null;
          apply(base.current - (latest.current - origin.current));
        });
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        apply(base.current - (event.clientX - origin.current));
        event.currentTarget.releasePointerCapture(event.pointerId);
        stop();
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        stop();
      }}
      onLostPointerCapture={stop}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(event) => {
        if (event.key === 'Home') {
          event.preventDefault();
          onChange(null);
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          apply(
            width +
              (event.key === 'ArrowLeft' ? 1 : -1) *
                (event.shiftKey ? 100 : 20),
          );
        }
      }}
    />
  );
}
