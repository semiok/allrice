'use client';

import type { WorkspaceFile } from './chatflow-types';
import { DshDialog } from './dsh-upstream/Dialog';
import styles from './dsh-saas.module.css';

interface WorkspaceFilePickerDialogProps {
  files: WorkspaceFile[];
  open: boolean;
  onAddFile: (file: WorkspaceFile) => void | Promise<void>;
  onClose: () => void;
  onOpenVersionHistory: (file: WorkspaceFile) => void | Promise<void>;
}

export function WorkspaceFilePickerDialog({
  files,
  open,
  onAddFile,
  onClose,
  onOpenVersionHistory,
}: WorkspaceFilePickerDialogProps) {
  if (!open) return null;

  return (
    <DshDialog
      ariaLabel="从工作区添加文件"
      eyebrow="工作区文件"
      onClose={onClose}
      title="选择要交给 Rice 的文件"
    >
      <div className={styles.fileList}>
        {files.map((file) => (
          <div className={styles.fileRow} key={file.id}>
            <span aria-hidden="true">□</span>
            <div>
              <strong>{file.fileName}</strong>
              <small>
                {file.category === 'exports'
                  ? file.deliverableVersion
                    ? `Rice 交付物 · v${file.deliverableVersion}`
                    : 'Rice 交付物'
                  : file.visibility === 'private'
                    ? '仅自己'
                    : '工作区公开'}
                {' · '}
                {Math.max(1, Math.ceil(file.sizeBytes / 1024))} KB
              </small>
            </div>
            <div className={styles.fileActions}>
              {file.category === 'exports' && file.deliverableVersion ? (
                <button
                  onClick={() => void onOpenVersionHistory(file)}
                  type="button"
                >
                  历史
                </button>
              ) : null}
              <button onClick={() => void onAddFile(file)} type="button">
                添加
              </button>
            </div>
          </div>
        ))}
        {files.length === 0 ? <p>工作区还没有可用文件。</p> : null}
      </div>
    </DshDialog>
  );
}
