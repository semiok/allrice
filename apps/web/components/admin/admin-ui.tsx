'use client';

import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import styles from './admin-ui.module.css';

export type AdminIconName =
  | 'organization'
  | 'employee'
  | 'activity'
  | 'settings'
  | 'user'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'upload'
  | 'chevron'
  | 'more'
  | 'close'
  | 'edit'
  | 'book'
  | 'folder'
  | 'wrench'
  | 'layers'
  | 'gauge'
  | 'thought'
  | 'message'
  | 'list'
  | 'info'
  | 'check'
  | 'play'
  | 'warning';

export function AdminIcon({ name }: { name: AdminIconName }) {
  const paths: Record<AdminIconName, ReactNode> = {
    organization: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 7h1m4 0h1M9 11h1m4 0h1M9 15h1m4 0h1m-5 6v-3h4v3" />
      </>
    ),
    employee: (
      <>
        <rect x="4" y="7" width="16" height="13" rx="2" />
        <path d="M12 3v4M8 12h.01M16 12h.01M9 16h6M1 12h3m16 0h3" />
      </>
    ),
    activity: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    settings: (
      <>
        <path d="M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10" />
        <circle cx="9" cy="6" r="2" />
        <circle cx="15" cy="12" r="2" />
        <circle cx="9" cy="18" r="2" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    upload: (
      <>
        <path d="M12 15V3m-4 4 4-4 4 4M4 15v5h16v-5" />
      </>
    ),
    chevron: <path d="m6 9 6 6 6-6" />,
    more: (
      <>
        <circle cx="5" cy="12" r=".75" />
        <circle cx="12" cy="12" r=".75" />
        <circle cx="19" cy="12" r=".75" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    edit: (
      <>
        <path d="m16 3 5 5-12 12-6 1 1-6L16 3Z" />
        <path d="m13 6 5 5" />
      </>
    ),
    book: (
      <>
        <path d="M12 5v16M3 3h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3V3Z" />
      </>
    ),
    folder: (
      <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 7h18l-3 13H3V7Z" />
    ),
    wrench: (
      <path d="M14 6a6 6 0 0 0-7 7L3 17a3 3 0 0 0 4 4l4-4a6 6 0 0 0 7-7l-4 4-4-4 4-4Z" />
    ),
    layers: (
      <>
        <path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5" />
      </>
    ),
    gauge: (
      <>
        <path d="M4 19a10 10 0 1 1 16 0M12 13l5-5" />
        <circle cx="12" cy="13" r="1.5" />
      </>
    ),
    thought: (
      <path d="M8 20H5l-2 2v-5a9 9 0 1 1 9 4h-1M8 10h.01M12 10h.01M16 10h.01" />
    ),
    message: (
      <path d="M21 15a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v9Z" />
    ),
    list: (
      <>
        <path d="m3 6 1 1 2-2m-3 7 1 1 2-2m-3 7 1 1 2-2M10 6h11M10 12h11M10 18h11" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7h.01" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    play: <path d="m6 3 15 9-15 9V3Z" />,
    warning: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 6v7M12 17h.01" />
      </>
    ),
  };
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function AdminButton({
  variant = 'secondary',
  icon,
  children,
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger' | 'icon';
  icon?: AdminIconName;
}) {
  return (
    <button
      {...props}
      type={type}
      className={`${styles.button} ${styles[variant] ?? ''} ${className}`}
    >
      {icon && <AdminIcon name={icon} />}
      {children}
    </button>
  );
}

export function AdminDialog({
  title,
  children,
  onClose,
  busy = false,
  size = 'default',
  ariaLabel,
  eyebrow,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  size?: 'default' | 'wide';
  ariaLabel?: string;
  eyebrow?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element.showModal();
    element.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`${styles.dialog} ${size === 'wide' ? styles.wideDialog : ''}`}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : titleId}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary',
          ),
        ].filter((element) => element.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (!first) {
          event.preventDefault();
          event.currentTarget.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last!.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || busy) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      <header className={styles.dialogHeader}>
        <div>
          <h2 id={titleId}>{title}</h2>
          {eyebrow && <p className={styles.dialogEyebrow}>{eyebrow}</p>}
        </div>
        <AdminButton
          variant="icon"
          icon="close"
          aria-label={`关闭${ariaLabel ?? title}`}
          disabled={busy}
          onClick={onClose}
        />
      </header>
      {children}
    </dialog>
  );
}

export function AdminMenu({
  label,
  children,
  triggerLabel,
  icon = 'more',
}: {
  label: string;
  children: ReactNode;
  triggerLabel?: string;
  icon?: AdminIconName;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (details.current && !details.current.contains(event.target as Node))
        details.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return (
    <details
      ref={details}
      className={`${styles.menu} ${triggerLabel ? styles.labeledMenu : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          details.current!.open = false;
          details.current!.querySelector('summary')?.focus();
        }
      }}
    >
      <summary aria-label={label}>
        {triggerLabel && <span>{triggerLabel}</span>}
        <AdminIcon name={icon} />
      </summary>
      <div
        className={styles.menuContent}
        role="group"
        aria-label={label}
        onClick={(event) => {
          if ((event.target as Element).closest('button')) {
            details.current!.open = false;
            details.current!.querySelector('summary')?.focus();
          }
        }}
      >
        {children}
      </div>
    </details>
  );
}

export function AdminStatus({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'success' | 'muted' | 'warning' | 'danger';
}) {
  return <span className={`${styles.status} ${styles[tone]}`}>{children}</span>;
}
