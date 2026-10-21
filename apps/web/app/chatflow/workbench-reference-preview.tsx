'use client';
import { useEffect, useState } from 'react';
import {
  parseArtifactPreview,
  workbenchJson,
  type ArtifactPreview,
} from '../../lib/chatflow/workbench-model';
import {
  NativeDocumentPreview,
  hasNativeViewport,
  hasSourcePreview,
} from './native-document-preview';
import { DocumentToolbar } from './document-reader';
import css from './document-reader.module.css';
export function ReferenceSnapshotPreview(props: {
  revisionId: string;
  title: string;
  workspaceId: string;
  headers: Record<string, string>;
  active: boolean;
}) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0),
    [source, setSource] = useState(false);
  const base = `/api/v1/references/revisions/${encodeURIComponent(props.revisionId)}`,
    query = '?workspaceId=' + encodeURIComponent(props.workspaceId);
  useEffect(() => {
    if (!props.active) return;
    const controller = new AbortController();
    setPreview(null);
    setError('');
    void workbenchJson(base + '/preview' + query, props.headers, {
      signal: controller.signal,
    })
      .then(parseArtifactPreview)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error ? error.message : '此资料版本暂不可用。',
          );
      });
    return () => controller.abort();
  }, [base, query, props.headers, attempt, props.active]);
  return (
    <div className={css.reader}>
      <DocumentToolbar
        title={props.title}
        downloadUrl={base + '/download' + query}
        actions={[
          { id: 'refresh', label: '刷新资料' },
          ...(hasSourcePreview(preview)
            ? [{ id: 'source', label: source ? '查看预览' : '查看源文本' }]
            : []),
        ]}
        onAction={(id) => {
          if (id === 'refresh') setAttempt((n) => n + 1);
          if (id === 'source') setSource((v) => !v);
        }}
      />
      <div
        className={`${css.content} ${hasNativeViewport(preview) && !source ? css.officeContent : ''}`}
      >
        {error ? (
          <p role="alert">{error}</p>
        ) : preview ? (
          <NativeDocumentPreview
            active={props.active}
            preview={preview}
            fileName={props.title}
            pageUrl={base + '/preview' + query}
            headers={props.headers}
            source={source}
          />
        ) : (
          <p role="status">正在读取资料版本…</p>
        )}
      </div>
    </div>
  );
}
