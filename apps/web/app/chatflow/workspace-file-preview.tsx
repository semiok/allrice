'use client';
import { useEffect, useState } from 'react';
import { ReadOnlyArtifactPreview } from './artifact-workbench';
import {
  parseArtifactPreview,
  workbenchJson,
  type ArtifactPreview,
} from '../../lib/chatflow/workbench-model';
import { isToolResultFile } from '../../lib/chatflow/document-reader-model';
import {
  DocumentText,
  DocumentToolbar,
  DocumentVersions,
} from './document-reader';
import reader from './document-reader.module.css';
import styles from './workbench.module.css';

export function WorkspaceFilePreview(props: {
  objectId: string;
  title: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  onVersion: (id: string, title: string) => void;
}) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState(false);
  const toolResult = isToolResultFile(props.title, props.objectId);
  const base = `/api/v1/files/${encodeURIComponent(props.objectId)}`;
  const query = `?workspaceId=${encodeURIComponent(props.workspaceId)}`;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setPreview(null);
    setSource(false);
    void workbenchJson(`${base}/preview${query}`, props.tenantHeaders, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setPreview(parseArtifactPreview(value));
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : '文件不可用，请刷新文件列表。',
          );
      });
    return () => controller.abort();
  }, [base, query, props.tenantHeaders, attempt]);
  return (
    <div className={reader.reader}>
      <DocumentToolbar
        title={
          toolResult
            ? props.title.startsWith('tool-result-web-search-')
              ? '搜索资料'
              : '工具记录'
            : props.title
        }
        downloadUrl={`${base}/download${query}&name=${encodeURIComponent(props.title)}`}
        actions={[
          { id: 'refresh', label: '刷新文件' },
          ...(preview?.kind === 'text'
            ? [{ id: 'source', label: source ? '查看预览' : '查看源文本' }]
            : []),
        ]}
        onAction={(id) => {
          if (id === 'refresh') setAttempt((n) => n + 1);
          if (id === 'source') setSource((v) => !v);
        }}
      >
        {!toolResult ? (
          <DocumentVersions
            objectId={props.objectId}
            workspaceId={props.workspaceId}
            headers={props.tenantHeaders}
            onSelect={(v) => props.onVersion(v.objectId, v.fileName)}
          />
        ) : null}
      </DocumentToolbar>
      <div className={reader.content}>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : preview ? (
          preview.kind === 'text' ? (
            <DocumentText
              text={preview.text}
              fileName={props.title}
              mediaType={preview.mediaType}
              source={source}
              toolResult={toolResult}
            />
          ) : (
            <ReadOnlyArtifactPreview preview={preview} />
          )
        ) : (
          <p role="status">正在加载文件预览…</p>
        )}
      </div>
    </div>
  );
}
