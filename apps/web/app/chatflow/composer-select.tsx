'use client';

import type { ReactNode, SelectHTMLAttributes } from 'react';
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import styles from './dsh-saas.module.css';

export function ComposerSelect({
  icon,
  label,
  compact,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  icon: ReactNode;
  label: ReactNode;
  compact: 'mode' | 'visibility';
}) {
  return (
    <span
      className={styles.composerSelect}
      data-compact={compact}
      data-disabled={props.disabled || undefined}
    >
      <span className={styles.composerSelectIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.composerSelectLabel} aria-hidden="true">
        {label}
      </span>
      <IconChevronDownOutlineRegular
        className={styles.composerSelectChevron}
        size={12}
        aria-hidden="true"
      />
      <select {...props}>{children}</select>
    </span>
  );
}
