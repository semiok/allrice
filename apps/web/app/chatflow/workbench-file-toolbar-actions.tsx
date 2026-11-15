'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  IconContextInjectionOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { workbenchJson } from '../../lib/chatflow/workbench-model';
import {
  WorkbenchFileActionsCatalogSchema,
  type WorkbenchFileActionsCatalog,
} from '../../lib/chatflow/workbench-file-actions';
import {
  useWorkbenchFileReference,
  type WorkbenchFileReferenceProps,
} from './use-workbench-file-reference';
import reader from './document-reader.module.css';

export function WorkbenchFileToolbarActions(
  props: WorkbenchFileReferenceProps & {
    objectId: string;
    fileName: string;
  },
) {
  const [catalog, setCatalog] = useState<WorkbenchFileActionsCatalog | null>(
    null,
  );
  const [revision, setRevision] = useState(0);
  const reference = useWorkbenchFileReference(props);
  const file = catalog?.files.find((f) => f.objectId === props.objectId);
  useEffect(() => {
    if (!props.active) return;
    const abort = new AbortController();
    setCatalog(null);
    const query = new URLSearchParams({
      workspaceId: props.workspaceId,
      scope: 'all',
      query: props.fileName.slice(0, 200),
    });
    void workbenchJson('/api/v1/workbench/files?' + query, props.headers, {
      signal: abort.signal,
    })
      .then(WorkbenchFileActionsCatalogSchema.parse)
      .then((data) => {
        if (!abort.signal.aborted) setCatalog(data);
      })
      .catch(() => {
        if (!abort.signal.aborted) setCatalog(null);
      });
    return () => abort.abort();
  }, [
    props.objectId,
    props.fileName,
    props.workspaceId,
    props.headers,
    props.active,
    revision,
  ]);
  useEffect(() => {
    const changed = () => setRevision((n) => n + 1);
    window.addEventListener('allrice:workbench-files-changed', changed);
    return () =>
      window.removeEventListener('allrice:workbench-files-changed', changed);
  }, []);
  if (!props.active) return null;
  if (!file || !catalog) return null;
  const actionButton = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    disabled = false,
  ) => (
    <Tooltip label={label} side="bottom" portal>
      <span className={reader.actionAnchor}>
        <button
          type="button"
          className={reader.iconButton}
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {icon}
        </button>
      </span>
    </Tooltip>
  );
  return (
    <>
      {catalog.quotableFileIds.includes(file.objectId) &&
        actionButton(
          '引用文件',
          <IconContextInjectionOutlineRegular size={20} />,
          () => void reference.useFile(file),
          !!props.readOnly || reference.using !== null,
        )}
      {(reference.error || reference.notice) && (
        <span
          className={reader.actionNotice}
          role={reference.error ? 'alert' : 'status'}
        >
          {reference.error || reference.notice}
        </span>
      )}
      {reference.pending && (
        <span className={reader.actionNotice} role="status">
          正在准备“{reference.pending.reference.fileName}”…{' '}
          <button type="button" onClick={reference.cancel}>
            取消等待
          </button>
        </span>
      )}
    </>
  );
}
