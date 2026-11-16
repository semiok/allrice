'use client';

import type { ReactNode } from 'react';
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './FilesBody.module.css';
import host from '../../file-row.module.css';

/** FilesBody.Entry's file branch, with sibling actions and host content slots.
 * The pinned native tree and its stylesheet remain unchanged. */
export function FileRow({
  fileName,
  fileId,
  onOpen,
  disabled,
  titleLeading,
  titleTrailing,
  subtitle,
  subtitleTitle,
  supplement,
  actions,
}: {
  fileName: string;
  fileId?: string;
  onOpen: () => void;
  disabled?: boolean;
  titleLeading?: ReactNode;
  titleTrailing?: ReactNode;
  subtitle: ReactNode;
  subtitleTitle: string;
  supplement?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <article
      className={`${css.row} ${host.row}`}
      data-native-file-row
      data-file-id={fileId}
    >
      <button
        type="button"
        className={host.open}
        onClick={onOpen}
        disabled={disabled}
        aria-label={fileName}
        title={fileName}
        data-file-row-open
      >
        <FileTypeIcon path={fileName} size={28} className={css.fileIcon} />
        <span className={host.details}>
          <span className={host.title}>
            {titleLeading}
            <span className={css.name} data-file-row-name>
              {fileName}
            </span>
            {titleTrailing}
          </span>
          <small
            className={host.subtitle}
            title={subtitleTitle}
            data-file-row-subtitle
          >
            {subtitle}
          </small>
          {supplement}
        </span>
      </button>
      <div className={host.actions} data-file-row-actions>
        {actions}
      </div>
    </article>
  );
}
