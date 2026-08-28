'use client';

import { createPortal } from 'react-dom';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import styles from './Dialog.module.css';

interface DshDialogProps {
  ariaLabel: string;
  eyebrow?: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  bodyClassName?: string;
}

export function DshDialog({
  ariaLabel,
  eyebrow,
  title,
  children,
  onClose,
  className = '',
  bodyClassName = '',
}: DshDialogProps) {
  const [mounted, setMounted] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
        aria-label={ariaLabel}
        aria-modal="true"
        className={`${styles.dialog} ${className}`.trim()}
        role="dialog"
      >
        <header className={styles.header}>
          <div>
            {eyebrow ? <p>{eyebrow}</p> : null}
            <h2>{title}</h2>
          </div>
          <button aria-label="关闭" onClick={onClose} type="button">
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
