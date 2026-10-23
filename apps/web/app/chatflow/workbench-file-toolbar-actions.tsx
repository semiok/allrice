'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  IconContextInjectionOutlineRegular,
  IconSettingsOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { workbenchJson } from '../../lib/chatflow/workbench-model';
import {
  WorkbenchFileActionsCatalogSchema,
  type WorkbenchFileActionsCatalog,
} from '../../lib/chatflow/workbench-file-actions';
import { FileSettings } from './workbench-files-panel';
import { WorkbenchFileIcon } from './workbench-file-icon';
import {
  useWorkbenchFileReference,
  type WorkbenchFileReferenceProps,
} from './use-workbench-file-reference';
import reader from './document-reader.module.css';

export function WorkbenchFileToolbarActions(
  props: WorkbenchFileReferenceProps & {
    objectId: string;
    fileName: string;
    referenceAction?: ReactNode;
  },
) {
  const [catalog, setCatalog] = useState<WorkbenchFileActionsCatalog | null>(
    null,
  );
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<'sharing' | 'reference' | null>(null);
  const reference = useWorkbenchFileReference(props);
  const file = catalog?.files.find((f) => f.objectId === props.objectId);
  useEffect(() => {
    if (!props.active) return;
    const abort = new AbortController();
    setCatalog(null);
    setEditor(null);
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
  if (!file || !catalog) return <>{props.referenceAction}</>;
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
      {props.referenceAction ??
        ((file.canMaintain || file.isReference) &&
          actionButton(
            file.isReference ? '已设为参考资料' : '设为参考资料',
            <WorkbenchFileIcon
              kind="reference"
              className={reader.opticalIcon}
            />,
            () => setEditor('reference'),
            file.isReference || !file.canMaintain,
          ))}
      {actionButton(
        '可见范围',
        <IconSettingsOutlineRegular size={20} className={reader.opticalIcon} />,
        () => setEditor('sharing'),
        !file.canMaintain,
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
      {editor && (
        <FileSettings
          key={file.objectId + '/' + file.revision + '/' + editor}
          file={file}
          mode={editor}
          options={catalog.options}
          workspaceId={props.workspaceId}
          headers={props.headers}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            window.dispatchEvent(new Event('allrice:workbench-files-changed'));
          }}
        />
      )}
    </>
  );
}
