'use client';
import { useEffect, useState } from 'react';
import {
  NativeDocumentPreview,
  hasSourcePreview,
  hasNativeViewport,
} from './native-document-preview';
import {
  parseArtifactPreview,
  workbenchJson,
  type ArtifactPreview,
} from '../../lib/chatflow/workbench-model';
import { isToolResultFile } from '../../lib/chatflow/document-reader-model';
import { DocumentToolbar } from './document-reader';
import reader from './document-reader.module.css';
import styles from './workbench.module.css';
import { WorkbenchFileToolbarActions } from './workbench-file-toolbar-actions';
import type { WorkbenchFileReferenceProps } from './use-workbench-file-reference';

export function WorkspaceFilePreview(props: {
  objectId: string;
  title: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  active?: boolean;
  unified?: boolean;
  fileActions?: Pick<
    WorkbenchFileReferenceProps,
    'sessionId' | 'readOnly' | 'onUse' | 'onTemplate'
  >;
}) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const toolResult = isToolResultFile(props.title, props.objectId);
  const baseUrl = props.unified ? '/api/v1/workbench/files' : '/api/v1/files';
  const base = `${baseUrl}/${encodeURIComponent(props.objectId)}`;
  const query = `?workspaceId=${encodeURIComponent(props.workspaceId)}&name=${encodeURIComponent(props.title)}`;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setPreview(null);
    setSource(false);
    setInteractive(false);
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
        missingFonts={
          preview?.kind === 'pdf' ? preview.missingFonts : undefined
        }
        title={
          toolResult
            ? props.title.startsWith('tool-result-web-search-')
              ? '搜索资料'
              : '工具记录'
            : props.title
        }
        downloadUrl={`${base}/download${query}`}
        quickActions={
          props.fileActions ? (
            <WorkbenchFileToolbarActions
              {...props.fileActions}
              objectId={props.objectId}
              fileName={props.title}
              workspaceId={props.workspaceId}
              headers={props.tenantHeaders}
              active={props.active ?? true}
            />
          ) : undefined
        }
        actions={[
          { id: 'refresh', label: '刷新文件' },
          ...(preview?.kind === 'html'
            ? [
                {
                  id: 'interactive',
                  label: interactive ? '切换静态网页' : '切换交互网页',
                },
              ]
            : []),
          ...(hasSourcePreview(preview)
            ? [{ id: 'source', label: source ? '查看预览' : '查看源文本' }]
            : []),
        ]}
        onAction={(id) => {
          if (id === 'refresh') setAttempt((n) => n + 1);
          if (id === 'source') setSource((v) => !v);
          if (id === 'interactive') {
            setInteractive((value) => !value);
            setSource(false);
          }
        }}
      />
      <div
        className={`${reader.content} ${hasNativeViewport(preview) && !source ? reader.officeContent : ''}`}
      >
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : preview ? (
          <NativeDocumentPreview
            active={props.active}
            preview={preview}
            fileName={props.title}
            pageUrl={`${base}/preview${query}`}
            headers={props.tenantHeaders}
            source={source}
            interactive={interactive}
            toolResult={toolResult}
          />
        ) : (
          <p role="status">正在加载文件预览…</p>
        )}
      </div>
    </div>
  );
}
