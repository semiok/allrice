'use client';

import { createPortal } from 'react-dom';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';

import styles from './Dialog.module.css';

interface DshDialogProps {
  ariaLabel: string;
  eyebrow?: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
  onBack?: () => void;
  backLabel?: string;
  closeDisabled?: boolean;
  className?: string;
  bodyClassName?: string;
  initialFocusSelector?: string;
}

export function DshDialog({
  ariaLabel,
  eyebrow,
  title,
  children,
  onClose,
  onBack,
  backLabel = '返回',
  closeDisabled = false,
  className = '',
  bodyClassName = '',
  initialFocusSelector,
}: DshDialogProps) {
  const [mounted, setMounted] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const hasBack = !!onBack;

  useEffect(() => {
    setMounted(true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    if (!mounted || !dialog.current) return;
    const section = dialog.current;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusable = () =>
      Array.from(
        section.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
        ),
      ).filter((node) => node.getClientRects().length > 0);
    (initialFocusSelector
      ? (section.querySelector<HTMLElement>(initialFocusSelector) ??
        focusable()[0] ??
        section)
      : (focusable()[0] ?? section)
    ).focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const nodes = focusable(),
        first = nodes[0],
        last = nodes.at(-1);
      if (!first || !last) {
        event.preventDefault();
        section.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !section.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !section.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [mounted, initialFocusSelector, hasBack]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <section
        ref={dialog}
        tabIndex={-1}
        aria-label={ariaLabel}
        aria-modal="true"
        className={`${styles.dialog} ${className}`.trim()}
        role="dialog"
      >
        <header
          className={
            onBack ? `${styles.header} ${styles.headerWithBack}` : styles.header
          }
        >
          {onBack ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.back}
              aria-label={backLabel}
              onClick={onBack}
              disabled={closeDisabled}
              icon={
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m10 5-7 7 7 7M3 12h18" />
                </svg>
              }
            />
          ) : null}
          <div className={onBack ? styles.headerTitle : undefined}>
            {eyebrow ? <p>{eyebrow}</p> : null}
            <h2>{title}</h2>
          </div>
          <button
            aria-label="关闭"
            onClick={onClose}
            type="button"
            disabled={closeDisabled}
          >
            ×
          </button>
        </header>
        <div className={`${styles.body} ${bodyClassName}`.trim()}>
          {children}
        </div>
      </section>
    </div>,
    document.body,
  );
}
