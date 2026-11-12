'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  WorkbenchDeliverable,
  EmployeeAccentColor,
} from '@allrice/contracts';
import {
  IconPlusOutlineRegular,
  IconLinkOutlineRegular,
  IconDownloadOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
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
import { useWorkbenchFileReference } from './use-workbench-file-reference';
import { copyWorkbenchFileLink } from './workbench-file-link';
import { WorkbenchDeliverablesActionsCatalogSchema } from '../../lib/chatflow/workbench-file-actions';
import detail from './workbench-files-panel.module.css';
import { employeeAccentStyle } from './employee-navigation';

/** Used by business file cards as well as the owner directory. Resolve metadata
 * before the toolbar mounts, including when an old card points at a denied file. */
export function WorkbenchDeliverablePreview(props: {
  scope: string;
  objectId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  active: boolean;
  employeeColors?: Record<string, EmployeeAccentColor | undefined>;
  onBack: () => void;
  onSource?: (sessionId: string) => void;
  fileActions?: Pick<
    WorkbenchFileReferenceProps,
    'sessionId' | 'readOnly' | 'onUse' | 'onTemplate'
  >;
}) {
  const key = `${props.scope}/${props.objectId}`;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    file: WorkbenchDeliverable;
    quotable: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    denied: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef<{ key: string; attempt: number } | null>(null);
  useEffect(() => {
    if (
      !props.active ||
      (loaded.current?.key === key && loaded.current.attempt === attempt)
    )
      return;
    const abort = new AbortController();
    setSnapshot(null);
    setFailure(null);
    void workbenchJson(
      '/api/v1/workbench/files?' +
        new URLSearchParams({
          workspaceId: props.workspaceId,
          view: 'deliverables',
          objectId: props.objectId,
        }),
      props.tenantHeaders,
      { signal: abort.signal },
    )
      .then(WorkbenchDeliverablesActionsCatalogSchema.parse)
      .then((data) => {
        if (abort.signal.aborted) return;
        const file = data.files.find(
          (file) => file.objectId === props.objectId,
        );
        if (file) {
          loaded.current = { key, attempt };
          setSnapshot({
            key,
            file,
            quotable: data.quotableFileIds.includes(file.objectId),
          });
        } else setFailure({ key, denied: true });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setFailure({
            key,
            denied: [401, 403, 404].includes(
              (error as { status?: number }).status ?? 0,
            ),
          });
      });
    return () => abort.abort();
  }, [
    key,
    props.workspaceId,
    props.objectId,
    props.tenantHeaders,
    props.active,
    attempt,
  ]);
  if (failure?.key === key)
    return failure.denied ? (
      <p className={detail.empty}>无权访问</p>
    ) : (
      <p className={detail.error} role="alert">
        预览加载失败{' '}
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          重新加载
        </button>
      </p>
    );
  if (snapshot?.key !== key) return <p role="status">正在加载文件预览…</p>;
  return (
    <div
      className={reader.reader}
      data-document-id={snapshot.file.artifact?.id ?? snapshot.file.objectId}
    >
      <WorkspaceFilePreview
        key={key}
        {...props}
        title={snapshot.file.fileName}
        unified
        deliverable={snapshot.file}
        quotable={snapshot.quotable}
      />
    </div>
  );
}

export function WorkspaceFilePreview(props: {
  objectId: string;
  title: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  active?: boolean;
  unified?: boolean;
  deliverable?: WorkbenchDeliverable;
  employeeColors?: Record<string, EmployeeAccentColor | undefined>;
  quotable?: boolean;
  onBack?: () => void;
  onSource?: (sessionId: string) => void;
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
  const [copyNotice, setCopyNotice] = useState('');
  const reference = useWorkbenchFileReference({
    workspaceId: props.workspaceId,
    sessionId: props.fileActions?.sessionId ?? null,
    headers: props.tenantHeaders,
    active: props.active ?? true,
    readOnly: props.fileActions?.readOnly,
    onUse: props.fileActions?.onUse ?? (() => {}),
    onTemplate: props.fileActions?.onTemplate,
  });
  const copyLink = () =>
    void copyWorkbenchFileLink(props.workspaceId, props.objectId)
      .then(() => setCopyNotice('链接已复制，仅你自己可以打开'))
      .catch(() => setCopyNotice('操作未完成，请重试。'));
  const quote = () => {
    if (props.deliverable) void reference.useFile(props.deliverable);
  };
  const quoteDisabled =
    !props.quotable ||
    !!props.fileActions?.readOnly ||
    reference.using !== null;
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
    setCopyNotice('');
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
    <div
      className={`${reader.reader} ${props.deliverable ? detail.deliveryDetail : ''}`}
    >
      {props.deliverable && (
        <button type="button" className={detail.back} onClick={props.onBack}>
          ‹ 交付成果
        </button>
      )}
      <DocumentToolbar
        key={
          props.deliverable ? `${props.objectId}/${props.active}` : undefined
        }
        delivery={!!props.deliverable}
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
          props.deliverable ? (
            <Tooltip label="引用到对话" side="bottom" portal>
              <span>
                <button
                  type="button"
                  className={reader.iconButton}
                  aria-label="引用到对话"
                  disabled={quoteDisabled}
                  onClick={quote}
                >
                  <IconPlusOutlineRegular size={20} />
                </button>
              </span>
            </Tooltip>
          ) : props.fileActions ? (
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
        trailingActions={
          props.deliverable ? (
            <Tooltip label="复制链接" side="bottom" portal>
              <button
                type="button"
                className={reader.iconButton}
                aria-label="复制链接"
                onClick={copyLink}
              >
                <IconLinkOutlineRegular size={20} />
              </button>
            </Tooltip>
          ) : undefined
        }
        actions={[
          ...(!props.deliverable ? [{ id: 'refresh', label: '刷新文件' }] : []),
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
        className={`${reader.content} ${hasNativeViewport(preview) && !source ? reader.officeContent : ''} ${props.deliverable ? detail.deliveryPreview : ''}`}
      >
        {error ? (
          <p className={styles.error} role="alert">
            {props.deliverable ? '预览加载失败' : error}
            {props.deliverable && (
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                重新加载
              </button>
            )}
          </p>
        ) : preview ? (
          <>
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
            {props.deliverable &&
              preview.kind === 'download_only' &&
              preview.retryable === true && (
                <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                  重新加载
                </button>
              )}
          </>
        ) : (
          <p role="status">正在加载文件预览…</p>
        )}
      </div>
      {props.deliverable && (
        <footer className={detail.detailFooter}>
          <dl className={detail.metadata}>
            <dt>
              {props.deliverable.origin === 'business-deliverable'
                ? '员工交付'
                : '我的上传'}
            </dt>
            <dd>
              {props.deliverable.origin === 'business-deliverable' &&
              props.deliverable.sources[0] ? (
                <>
                  <span
                    className={detail.employeeAvatar}
                    style={employeeAccentStyle(
                      props.deliverable.sources[0]!.employeeName,
                      props.employeeColors?.[
                        props.deliverable.sources[0]!.employeeInstanceId
                      ],
                    )}
                    aria-hidden="true"
                  >
                    {Array.from(props.deliverable.sources[0]!.employeeName)[0]}
                  </span>
                  {props.deliverable.sources[0]!.employeeName}
                </>
              ) : (
                '我'
              )}{' '}
              · {new Date(props.deliverable.createdAt).toLocaleString('zh-CN')}
            </dd>
            <dt>来自对话</dt>
            <dd>
              {props.deliverable.sources.length
                ? props.deliverable.sources.map((source) => (
                    <button
                      type="button"
                      className={detail.sourceLink}
                      key={source.sessionId}
                      onClick={() => props.onSource?.(source.sessionId)}
                    >
                      {source.sessionTitle} ›
                    </button>
                  ))
                : '—'}
            </dd>
          </dl>
          <div className={detail.detailActions}>
            <button
              type="button"
              className={detail.primaryAction}
              disabled={quoteDisabled}
              onClick={quote}
            >
              <IconPlusOutlineRegular size={18} />
              引用到对话
            </button>
            <button
              type="button"
              onClick={() => {
                const a = document.createElement('a');
                a.href = `${base}/download${query}`;
                a.download = props.title;
                document.body.append(a);
                a.click();
                a.remove();
              }}
            >
              <IconDownloadOutlineRegular size={18} />
              下载
            </button>
            <button type="button" onClick={copyLink}>
              <IconLinkOutlineRegular size={18} />
              复制链接
            </button>
          </div>
          {(reference.error || reference.notice || copyNotice) && (
            <p
              role={reference.error ? 'alert' : 'status'}
              className={detail.notice}
            >
              {reference.error || reference.notice || copyNotice}
            </p>
          )}
          {reference.pending && (
            <p role="status">
              正在准备“{reference.pending.reference.fileName}”…{' '}
              <button type="button" onClick={reference.cancel}>
                取消等待
              </button>
            </p>
          )}
          <p className={detail.privateNote}>交付成果只有你自己能看到。</p>
        </footer>
      )}
    </div>
  );
}
