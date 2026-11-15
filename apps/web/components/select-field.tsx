'use client';

import { forwardRef, type SelectHTMLAttributes } from 'react';
import css from './select-field.module.css';

/**
 * DSH rc.2 has no general Select export. Keep the browser's native select and
 * use the approved expression-preference frame; no custom arrow or menu.
 */
export const SelectField = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function SelectField({ className, style, children, ...props }, ref) {
  return (
    <span
      className={[css.field, className].filter(Boolean).join(' ')}
      style={style}
      data-select-field
    >
      <select {...props} ref={ref} className={css.control}>
        {children}
      </select>
    </span>
  );
});
