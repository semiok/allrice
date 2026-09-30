'use client';

import { useState, type CSSProperties } from 'react';
import {
  FileTypeIcon,
  IconClockOutlineRegular,
  IconSearchOutlineRegular,
  Tooltip,
  classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { WorkspaceFile } from './chatflow-types';
import type { WorkspaceFileAddResult } from './use-attachments';
import { DshDialog } from './dsh-upstream/Dialog';
import styles from './workspace-file-picker-dialog.module.css';

interface WorkspaceFilePickerDialogProps {
  files: WorkspaceFile[];
  open: boolean;
  employeeName: string;
  accentStyle: CSSProperties;
  attachedFileIds: string[];
  onAddFiles: (files: WorkspaceFile[]) => Promise<WorkspaceFileAddResult>;
  onClose: () => void;
  onOpenVersionHistory: (file: WorkspaceFile) => void | Promise<void>;
}

export function WorkspaceFilePickerDialog({
  files,
  open,
  employeeName,
  accentStyle,
  attachedFileIds,
  onAddFiles,
  onClose,
  onOpenVersionHistory,
}: WorkspaceFilePickerDialogProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  // Keep this draft while visiting version history; the parent keys it by session.
  const selectedFiles = files.filter(
    (file) => selected.includes(file.id) && !attachedFileIds.includes(file.id),
  );
  const matching = files.filter((file) =>
    file.fileName
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const close = () => {
    setQuery('');
    setSelected([]);
    setDetailId(null);
    setError('');
    onClose();
  };
  const add = async () => {
    if (adding || !selectedFiles.length) return;
    setAdding(true);
    setError('');
    try {
      const result = await onAddFiles(selectedFiles);
      setSelected((current) =>
        current.filter((id) => !result.addedIds.includes(id)),
      );
      setError(result.error ?? '');
      if (!result.error) {
        setQuery('');
        setDetailId(null);
      }
    } catch {
      setError('文件添加失败，请重试。');
    } finally {
      setAdding(false);
    }
  };
  if (!open) return null;

  return (
    <DshDialog
      ariaLabel="从工作区添加文件"
      className={styles.dialog}
      bodyClassName={styles.body}
      initialFocusSelector="input[type=search]"
      onClose={close}
      title="从工作区添加"
    >
      <div className={styles.content} style={accentStyle}>
        <div className={styles.searchArea}>
          <p className={styles.description}>
            选择本轮交给 {employeeName} 的文件
          </p>
          <label className={styles.search}>
            <IconSearchOutlineRegular size={18} />
            <input
              aria-label="搜索文件名"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索文件名…"
              type="search"
              value={query}
            />
          </label>
          <p className={styles.count} aria-live="polite">
            {query.trim()
              ? `${matching.length} 个匹配文件`
              : `${files.length} 个文件`}
          </p>
        </div>
        <ul className={styles.files} aria-label="工作区文件">
          {matching.map((file) => {
            const attached = attachedFileIds.includes(file.id);
            const checked = attached || selected.includes(file.id);
            const expanded = detailId === file.id;
            const hasHistory =
              file.category === 'exports' && !!file.deliverableVersion;
            const meta =
              file.category === 'exports'
                ? `交付文件${file.deliverableVersion ? ` · v${file.deliverableVersion}` : ''}`
                : file.visibility === 'private'
                  ? '仅自己可见'
                  : '工作区公开';
            const size = `${Math.max(1, Math.ceil(file.sizeBytes / 1024))} KB`;
            const tailLength = file.fileName.length > 36 ? 8 : 0;
            return (
              <li
                className={styles.file}
                key={file.id}
                data-selected={checked || undefined}
              >
                <div className={styles.row}>
                  <label className={styles.select}>
                    <input
                      aria-label={`选择 ${file.fileName}`}
                      checked={checked}
                      disabled={adding || attached}
                      onChange={(event) => {
                        setError('');
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, file.id]
                            : current.filter((id) => id !== file.id),
                        );
                      }}
                      type="checkbox"
                    />
                    <span className={styles.fileIcon} aria-hidden="true">
                      <FileTypeIcon
                        kind={classifyFileType(file.fileName)}
                        size={20}
                      />
                    </span>
                    <span className={styles.copy}>
                      <Tooltip label={file.fileName} side="top" portal>
                        <span className={styles.fileName}>
                          <span className={styles.stem}>
                            {tailLength
                              ? file.fileName.slice(0, -tailLength)
                              : file.fileName}
                          </span>
                          {tailLength ? (
                            <span className={styles.tail}>
                              {file.fileName.slice(-tailLength)}
                            </span>
                          ) : null}
                        </span>
                      </Tooltip>
                      <span className={styles.meta}>
                        {attached ? '已在本轮 · ' : ''}
                        {meta} · {size}
                      </span>
                    </span>
                  </label>
                  <button
                    aria-label={`文件详情：${file.fileName}`}
                    aria-controls={`file-detail-${file.id}`}
                    aria-expanded={expanded}
                    className={styles.detailButton}
                    onClick={() => setDetailId(expanded ? null : file.id)}
                    type="button"
                  >
                    <IconClockOutlineRegular size={18} />
                  </button>
                </div>
                {expanded ? (
                  <div className={styles.detail} id={`file-detail-${file.id}`}>
                    <p>{file.fileName}</p>
                    <div className={styles.version}>
                      <span>
                        {meta} · {size}
                      </span>
                      {hasHistory ? (
                        <button
                          disabled={adding}
                          onClick={() => void onOpenVersionHistory(file)}
                          type="button"
                        >
                          查看版本历史
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
          {!matching.length ? (
            <li className={styles.empty}>
              {files.length ? '没有找到匹配的文件' : '工作区还没有可用文件'}
            </li>
          ) : null}
        </ul>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <footer className={styles.footer}>
          <span className={styles.selection} role="status" aria-live="polite">
            {selectedFiles.length
              ? `已选 ${selectedFiles.length} 项`
              : '支持多选'}
          </span>
          <div className={styles.actions}>
            <button className={styles.cancel} onClick={close} type="button">
              取消
            </button>
            <button
              className={styles.add}
              disabled={adding || !selectedFiles.length}
              onClick={() => void add()}
              type="button"
            >
              {adding ? '正在添加…' : '添加到本轮'}
            </button>
          </div>
        </footer>
      </div>
    </DshDialog>
  );
}
