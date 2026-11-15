'use client';
import { documentPreviewPresentation } from './document-preview-presentation';
import { useEffect, useState, type ReactNode } from 'react';
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
import detail from './workbench-files-panel.module.css';
export function ReferenceSnapshotPreview(props: {
  revisionId: string;
  title: string;
  workspaceId: string;
  headers: Record<string, string>;
  active: boolean;
  material?: {
    purpose: string;
    beforePreview?: ReactNode;
    footer: ReactNode;
    quickActions?: ReactNode;
    trailingActions?: ReactNode;
  };
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
    setSource(false);
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
  const nativeViewport = hasNativeViewport(preview) && !source;
  const pdfFooter = !!props.material && preview?.kind === 'pdf' && !source;
  const content = (
    <div
      className={`${css.content} ${nativeViewport ? css.officeContent : ''} ${props.material ? detail.deliveryPreview : ''} ${props.material && nativeViewport ? detail.deliveryViewport : ''} ${props.material ? documentPreviewPresentation(preview, source) : ''}`}
    >
      {error && !props.material ? (
        <p role="alert">{error}</p>
      ) : error ? (
        <div className={detail.previewError} role="alert">
          <span>预览加载失败</span>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            重新加载
          </button>
        </div>
      ) : preview ? (
        <NativeDocumentPreview
          active={props.active}
          preview={preview}
          fileName={props.title}
          pageUrl={base + '/preview' + query}
          headers={props.headers}
          source={source}
          footer={pdfFooter ? props.material?.footer : undefined}
        />
      ) : (
        <p role="status">
          {props.material ? '正在加载文件预览…' : '正在读取资料版本…'}
        </p>
      )}
    </div>
  );
  return (
    <div
      className={`${css.reader} ${props.material ? detail.deliveryDetail : ''}`}
    >
      <DocumentToolbar
        key={base}
        delivery={!!props.material}
        description={props.material?.purpose}
        title={props.title}
        downloadUrl={base + '/download' + query}
        missingFonts={
          preview?.kind === 'pdf' ? preview.missingFonts : undefined
        }
        quickActions={props.material?.quickActions}
        trailingActions={props.material?.trailingActions}
        actions={[
          ...(!props.material ? [{ id: 'refresh', label: '刷新资料' }] : []),
          ...(hasSourcePreview(preview)
            ? [{ id: 'source', label: source ? '查看预览' : '查看源文本' }]
            : []),
        ]}
        onAction={(id) => {
          if (id === 'refresh') setAttempt((n) => n + 1);
          if (id === 'source') setSource((v) => !v);
        }}
      />
      {props.material?.beforePreview}
      {props.material ? (
        <div className={detail.deliveryReadingArea}>
          {content}
          {!pdfFooter && props.material.footer}
        </div>
      ) : (
        content
      )}
    </div>
  );
}
