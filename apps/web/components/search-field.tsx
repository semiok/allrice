'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import { IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './search-field.module.css';

/** Shared search chrome, matching the deliverables “查找文件” field. */
export const SearchField = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>
>(function SearchField({ className, style, ...props }, ref) {
  return (
    <label
      className={[css.field, className].filter(Boolean).join(' ')}
      style={style}
      data-search-field
    >
      <IconSearchOutlineRegular size={18} aria-hidden="true" />
      <input {...props} ref={ref} type="search" className={css.input} />
    </label>
  );
});
