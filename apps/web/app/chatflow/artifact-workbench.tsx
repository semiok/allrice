'use client';
import {
  DockLayout,
  dockPaneIds,
  findPaneContentTab,
  findTabPane,
} from '@deepseek-ai/dsh-client-ui-dockkit';
import { GUIDE_KIND, pageAddress } from './dsh-upstream/dock/contract/seed';
import { dockLabels, useNativeDock } from './use-native-dock';
import { WorkspaceFileTree } from './workspace-file-tree';
import { WorkspaceFilePreview } from './workspace-file-preview';
import { NativePdfPreview } from './native-pdf-preview';
import { NativeImagePreview } from './native-image-preview';
import { OfficePreview } from './office-preview';
import {
  DocumentToolbar,
  DocumentVersions,
  DocumentText,
} from './document-reader';
import reader from './document-reader.module.css';
import { isToolResultExport } from '../../lib/chatflow/document-reader-model';
import { ChangesetPanel } from './changeset-panel';
import {
  lazy,
  Component,
  Suspense,
  type ReactNode,
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type WorkbenchArtifact,
  type ReviewContinuationInput,
} from '@allrice/contracts';
import {
  artifactKindLabel,
  parseArtifactDetail,
  parseArtifactPreview,
  workbenchJson,
  type ArtifactPreview,
  type ArtifactCursor,
} from '../../lib/chatflow/workbench-model';
import styles from './workbench.module.css';
import sidebarUi from './dsh-upstream/dock/SidebarRight.module.css';
import { inputRetry } from '../../lib/chatflow/input-retry';
import { readJson } from './chatflow-utils';
import { AssistantMarkdown } from './assistant-markdown';

const RichDiff = lazy(() =>
  import('./cline-adapter/tool-file-diff').then((m) => ({
    default: m.ToolFileDiff,
  })),
);
class DiffBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p role="status">Diff 组件加载失败，可使用前后文本视图或下载此版本。</p>
    ) : (
      this.props.children
    );
  }
}
type Props = {
  open: boolean;
  width: number;
  dockScope: string;
  filesRequest?: number;
  selectionRequest?: number;
  onBrowseFiles?: () => void;
  sessionId: string | null;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  artifacts: WorkbenchArtifact[];
  selectedId: string | null;
  nextCursor: ArtifactCursor | null;
  listError: string;
  listLoading: boolean;
  narrow: boolean;
  noticeId?: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onReload: (cursor?: ArtifactCursor) => Promise<void>;
  onContinued?: (runId: string) => void;
};

/** Focus-contained narrow panel; keeps the same component mounted when resized. */
export function ArtifactWorkbench(props: Props) {
  const panel = useRef<HTMLElement>(null),
    previousFocus = useRef<HTMLElement | null>(null);
  const close = props.onClose;
  const dock = useNativeDock(props.dockScope, () => true, props.onClose);
  const fullscreen = props.narrow || dock.surface.layout.mode === 'fullscreen';
  useEffect(() => {
    if (!props.open) return;
    const element = panel.current;
    const active = document.activeElement;
    // A desktop → drawer resize may happen while editing inside the panel.
    // Keep its external opener, not an input which disappears on close.
    if (active instanceof HTMLElement && !element?.contains(active))
      previousFocus.current = active;
    // The persistent desktop panel must never take the composer's focus.
    if (!fullscreen) return;
    element?.focus();
    return () => {
      // Respect an explicit focus destination chosen by the parent onClose.
      if (
        previousFocus.current?.isConnected &&
        (document.activeElement === document.body ||
          element?.contains(document.activeElement))
      )
        previousFocus.current.focus();
    };
  }, [fullscreen, props.open]);
  const previousSelection = useRef<string | null | undefined>(undefined);
  const previousRequest = useRef(0);
  function openArtifact(id: string, paneId?: Parameters<typeof dock.open>[3]) {
    const artifact = props.artifacts.find((item) => item.id === id);
    dock.open(
      'artifact',
      id,
      artifact
        ? `${artifact.version.fileName} · v${artifact.version.version}`
        : '所选成果',
      paneId,
    );
  }
  useEffect(() => {
    if (
      previousSelection.current === props.selectedId &&
      previousRequest.current === (props.selectionRequest ?? 0)
    )
      return;
    const restoring =
      previousSelection.current === undefined &&
      !props.selectionRequest &&
      Object.values(dock.surface.layout.tabs).some(
        (tab) => tab.kind === 'artifact' && tab.contentId === props.selectedId,
      );
    previousSelection.current = props.selectedId;
    previousRequest.current = props.selectionRequest ?? 0;
    if (props.selectedId && !restoring) openArtifact(props.selectedId);
    else if (!props.selectedId && props.selectionRequest)
      dock.open(GUIDE_KIND, pageAddress(GUIDE_KIND), '交付成果');
  });
  const lastFilesRequest = useRef(0);
  useEffect(() => {
    if (!props.filesRequest || lastFilesRequest.current === props.filesRequest)
      return;
    lastFilesRequest.current = props.filesRequest;
    dock.open('files', pageAddress('files'), '工作区文件');
  });
  return (
    <>
      {props.narrow && props.open ? (
        <div className={styles.backdrop} onClick={close} aria-hidden="true" />
      ) : null}
      <aside
        id="artifact-workbench"
        ref={panel}
        tabIndex={-1}
        className={`${styles.panel} ${sidebarUi.panel} ${styles.nativeDock}`}
        style={
          {
            width: fullscreen ? '100%' : props.width,
            '--dsh-sidebar-width': fullscreen ? '100vw' : `${props.width}px`,
          } as CSSProperties
        }
        data-sidebar-right-open={props.open || undefined}
        data-sidebar-right-panel={fullscreen ? 'fullscreen' : 'push'}
        aria-hidden={!props.open || undefined}
        inert={!props.open}
        role={fullscreen ? 'dialog' : 'complementary'}
        aria-label="交付成果"
        aria-modal={fullscreen ? true : undefined}
        data-fullscreen={fullscreen || undefined}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            (event.target instanceof Element &&
              event.target.closest('[role="menu"]'))
          )
            return;
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
          if (fullscreen && event.key === 'Tab') {
            const nodes = [
              ...panel.current!.querySelectorAll<HTMLElement>(
                'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary',
              ),
            ].filter((n) => n.getClientRects().length);
            const first = nodes[0],
              last = nodes.at(-1);
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === panel.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <DockLayout
          state={dock.surface.layout}
          intents={{
            ...dock.intents,
            focusTab: (id) => {
              const tab = dock.surface.layout.tabs[id];
              if (tab?.kind === 'artifact') props.onSelect(tab.contentId);
              dock.intents.focusTab(id);
            },
          }}
          labels={dockLabels}
          canSplit={
            !props.narrow && dockPaneIds(dock.surface.layout).length < 2
          }
          hideSplitWhenBlocked
          dropZones="horizontal"
          minPaneFraction={0.2}
          canCloseTab={dock.canCloseTab}
          canAddTab={(pane) =>
            !findPaneContentTab(
              dock.surface.layout,
              pane,
              pageAddress(GUIDE_KIND),
              GUIDE_KIND,
            )
          }
          keepMounted={() => true}
          renderTab={(tab) =>
            tab.kind === 'files' ? (
              <WorkspaceFileTree
                tabId={tab.id}
                workspaceId={props.workspaceId}
                sessionId={props.sessionId ?? 'draft'}
                tenantHeaders={props.tenantHeaders}
                onOpen={(file) => {
                  const artifact = props.artifacts.find(
                    (item) => item.object.id === file.id,
                  );
                  if (artifact)
                    openArtifact(
                      artifact.id,
                      findTabPane(dock.surface.layout, tab.id).id,
                    );
                  else
                    dock.open(
                      'file',
                      file.id,
                      file.fileName,
                      findTabPane(dock.surface.layout, tab.id).id,
                    );
                }}
              />
            ) : tab.kind === 'file' ? (
              <WorkspaceFilePreview
                objectId={tab.contentId}
                title={tab.title}
                workspaceId={props.workspaceId}
                tenantHeaders={props.tenantHeaders}
                onVersion={(id, title) =>
                  dock.open(
                    'file',
                    id,
                    title,
                    findTabPane(dock.surface.layout, tab.id).id,
                  )
                }
              />
            ) : (
              <ArtifactTabBody
                {...props}
                key={tab.id}
                selectedId={tab.kind === 'artifact' ? tab.contentId : null}
                onCatalog={() =>
                  dock.open(
                    GUIDE_KIND,
                    pageAddress(GUIDE_KIND),
                    '交付成果',
                    findTabPane(dock.surface.layout, tab.id).id,
                  )
                }
                onFiles={() => {
                  props.onBrowseFiles?.();
                  dock.open(
                    'files',
                    pageAddress('files'),
                    '工作区文件',
                    findTabPane(dock.surface.layout, tab.id).id,
                  );
                }}
                onSelect={(id) => {
                  props.onSelect(id);
                  openArtifact(id, findTabPane(dock.surface.layout, tab.id).id);
                }}
              />
            )
          }
          chrome={
            <>
              {!props.narrow ? (
                <button
                  type="button"
                  aria-label={fullscreen ? '退出全屏' : '全屏查看'}
                  onClick={() => dock.setFullscreen(!fullscreen)}
                >
                  {fullscreen ? '↙' : '⛶'}
                </button>
              ) : null}
              <button type="button" aria-label="关闭工作台" onClick={close}>
                ×
              </button>
            </>
          }
        />
      </aside>
    </>
  );
}

function ArtifactTabBody(
  props: Props & { onFiles: () => void; onCatalog: () => void },
) {
  const artifactId = props.selectedId;
  if (artifactId && props.sessionId)
    return (
      <div className={reader.reader}>
        {props.listError ? (
          <p className={styles.error} role="alert">
            {props.listError}
          </p>
        ) : null}
        {props.noticeId && props.noticeId !== artifactId ? (
          <p className={styles.notice} role="status">
            新成果已就绪。
            <button
              type="button"
              onClick={() => props.onSelect(props.noticeId!)}
            >
              查看新成果
            </button>
          </p>
        ) : null}
        <ArtifactReview
          key={`${props.workspaceId}/${props.sessionId}/${artifactId}`}
          artifactId={artifactId}
          sessionId={props.sessionId}
          workspaceId={props.workspaceId}
          tenantHeaders={props.tenantHeaders}
          onSelect={props.onSelect}
          onContinued={props.onContinued}
          onCatalog={props.onCatalog}
          onReload={props.onReload}
        />
      </div>
    );
  return (
    <div className={styles.body}>
      <div className={styles.row}>
        <button type="button" onClick={props.onFiles}>
          工作区文件
        </button>
        <button
          type="button"
          disabled={props.listLoading || !props.sessionId}
          onClick={() => void props.onReload()}
        >
          刷新列表
        </button>
      </div>
      {props.listError ? (
        <p className={styles.error} role="alert">
          {props.listError}
        </p>
      ) : null}
      <ArtifactSummaryCards
        artifacts={props.artifacts}
        onOpen={props.onSelect}
      />
      {props.nextCursor ? (
        <button
          type="button"
          disabled={props.listLoading}
          onClick={() => void props.onReload(props.nextCursor!)}
        >
          加载更早成果
        </button>
      ) : null}
      {!props.artifacts.length ? (
        <p className={styles.muted}>
          {props.listLoading
            ? '正在加载成果…'
            : '交付的报告、文件与修改方案会显示在这里。'}
        </p>
      ) : null}
    </div>
  );
}

/** Bounded safe Markdown; large documents retain the existing paged-text path. */
export function SafeDocument({ text }: { text: string }) {
  return text.length <= 80_000 && text.split('\n').length <= 1500 ? (
    <div className={styles.document}>
      <AssistantMarkdown text={text} allowRemoteImages={false} />
    </div>
  ) : (
    <TextPage text={text} label="正文（分页只读）" />
  );
}

/** Shared read-only inspector; deliberately has no feedback, approval, apply or
 * resume callbacks. The server must separately authorize the inspection scope. */
export function ReadOnlyArtifactPreview({
  preview,
}: {
  preview: ArtifactPreview;
}) {
  if (preview.kind === 'pdf')
    return <NativePdfPreview base64={preview.base64} />;
  if (preview.kind === 'office')
    return <OfficePreview preview={preview} key={preview.checksum} />;
  if (preview.kind === 'text')
    return preview.mediaType === 'text/markdown' ||
      preview.mediaType === 'text/plain' ? (
      <SafeDocument text={preview.text} />
    ) : (
      <TextPage text={preview.text} label="静态源码（不执行）" />
    );
  if (preview.kind === 'image')
    return (
      <NativeImagePreview
        alt="成果静态证据预览"
        src={`data:${preview.mediaType};base64,${preview.base64}`}
      />
    );
  if (preview.kind === 'changeset')
    return (
      <>
        {preview.changeset.files.map((file) => (
          <section key={file.path}>
            <h5>{file.path}</h5>
            <DiffBoundary>
              <Suspense fallback={<p>正在加载 Diff…</p>}>
                <RichDiff
                  path={file.path}
                  before={file.before?.text ?? null}
                  after={file.after?.text ?? null}
                  mode="unified"
                />
              </Suspense>
            </DiffBoundary>
          </section>
        ))}
      </>
    );
  return (
    <p>{preview.reason} 管理检查不代替使用者操作，请由本人到租户工作台下载。</p>
  );
}

export function ArtifactSummaryCards({
  artifacts,
  onOpen,
}: {
  artifacts: WorkbenchArtifact[];
  onOpen: (id: string) => void;
}) {
  const series = new Map<string, WorkbenchArtifact>();
  for (const a of artifacts)
    if (
      !series.has(a.version.seriesId) ||
      series.get(a.version.seriesId)!.version.version < a.version.version
    )
      series.set(a.version.seriesId, a);
  const newest = [...series.values()];
  return (
    <div className={styles.summaries}>
      {newest.map((a) => (
        <button
          type="button"
          className={styles.summary}
          key={a.id}
          onClick={() => onOpen(a.id)}
        >
          <span>▤ {a.version.fileName}</span>
          <small>
            {artifactKindLabel(a)} · v{a.version.version} · 查看
          </small>
        </button>
      ))}
    </div>
  );
}

function TextPage({ text, label }: { text: string; label: string }) {
  const [page, setPage] = useState(0),
    lines = text.split('\n'),
    pages = Math.max(1, Math.ceil(lines.length / 100));
  const current = Math.min(page, pages - 1);
  return (
    <>
      <div className={styles.preview} aria-label={label}>
        <pre>
          {lines.slice(current * 100, (current + 1) * 100).map((line, i) => (
            <span className={styles.line} key={i}>
              <span aria-hidden="true">{current * 100 + i + 1} </span>
              <code>
                {line || '\u00a0'}
                {'\n'}
              </code>
            </span>
          ))}
        </pre>
      </div>
      {pages > 1 ? (
        <div className={styles.row}>
          <button
            type="button"
            disabled={current === 0}
            onClick={() => setPage((v) => v - 1)}
          >
            上一页正文
          </button>
          <span>
            {current + 1}/{pages} 页 · {lines.length} 行
          </span>
          <button
            type="button"
            disabled={current + 1 === pages}
            onClick={() => setPage((v) => v + 1)}
          >
            下一页正文
          </button>
        </div>
      ) : null}
    </>
  );
}

function ArtifactReview({
  artifactId,
  sessionId,
  workspaceId,
  tenantHeaders,
  onSelect,
  onContinued,
  onCatalog,
  onReload,
}: {
  artifactId: string;
  sessionId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  onSelect: (id: string) => void;
  onContinued?: (runId: string) => void;
  onCatalog: () => void;
  onReload: () => Promise<void>;
}) {
  const [artifact, setArtifact] = useState<WorkbenchArtifact | null>(null),
    [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [planSent, setPlanSent] = useState(false);
  async function continuePlan(
    review: Extract<ReviewContinuationInput, { kind: 'plan_review' }>,
  ) {
    setBusy(true);
    setError('');
    try {
      const body = {
        text: '认可本版计划并继续',
        deliveryMode: 'follow_up',
        attachmentIds: [],
        reviewContinuation: review,
      };
      const retry = await inputRetry(`${workspaceId}/${sessionId}`, body);
      const result = await readJson<{ run: { id: string } }>(
        await fetch(
          `/api/v1/sessions/${sessionId}/messages?workspaceId=${workspaceId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({ ...body, clientMessageId: retry.id }),
          },
        ),
      );
      setPlanSent(true);
      setNotice('计划确认已发送，可在对话中查看进展。');
      onContinued?.(result.run.id);
      return true;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : '后续任务提交失败，可安全重试。',
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [previewError, setPreviewError] = useState(''),
    [previewRetry, setPreviewRetry] = useState(0);
  const [path, setPath] = useState('');
  const [view, setView] = useState<'preview' | 'diff' | 'source'>('preview'),
    [mode, setMode] = useState<'split' | 'unified'>('split'),
    [rawSide, setRawSide] = useState<'before' | 'after'>('after');
  const [previous, setPrevious] = useState<{
      artifact: WorkbenchArtifact;
      preview: ArtifactPreview;
    } | null>(null),
    [ready, setReady] = useState(false);
  const generation = useRef(0),
    pending = useRef<AbortController | null>(null);
  const endpoint = `/api/v1/sessions/${sessionId}/artifacts/${artifactId}`,
    query = `?workspaceId=${workspaceId}`;
  const refresh = useCallback(
    async (reset = false) => {
      const token = ++generation.current;
      pending.current?.abort();
      const control = new AbortController();
      pending.current = control;
      if (reset) setError('');
      try {
        const result = parseArtifactDetail(
          await workbenchJson(endpoint + query, tenantHeaders, {
            signal: control.signal,
          }),
        );
        if (
          result.artifact.id !== artifactId ||
          result.artifact.version.sessionId !== sessionId
        )
          throw Error('成果所属会话不匹配');
        if (token !== generation.current) return;
        setArtifact(result.artifact);
        setReady(true);
      } catch (cause) {
        if (token === generation.current && !control.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '成果不可用');
          setReady(false);
          setArtifact(null);
          setPreview(null);
        }
      }
    },
    [endpoint, query, tenantHeaders, artifactId, sessionId],
  );
  useEffect(() => {
    void refresh(true);
    return () => {
      generation.current++;
      pending.current?.abort();
    };
  }, [refresh]);
  useEffect(() => {
    if (!artifact || preview) return;
    const controller = new AbortController();
    setPreviewError('');
    workbenchJson(`${endpoint}/content${query}`, tenantHeaders, {
      signal: controller.signal,
    })
      .then(parseArtifactPreview)
      .then((value) => {
        if (!controller.signal.aborted) {
          setPreview(value);
          if (value.kind === 'changeset') {
            setPath(value.changeset.files[0]!.path);
            setView('diff');
          }
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setPreviewError(
            cause instanceof Error ? cause.message : '预览不可用',
          );
      });
    return () => controller.abort();
  }, [artifact?.id, !!preview, endpoint, query, tenantHeaders, previewRetry]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!busy) void refresh(false);
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh, busy]);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const sync = () => setMode(mq.matches ? 'unified' : 'split');
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  useEffect(() => {
    if (
      view !== 'diff' ||
      !artifact?.version.parentVersionId ||
      artifact.kind === 'changeset' ||
      previous
    )
      return;
    const controller = new AbortController(),
      id = artifact.version.parentVersionId,
      url = `/api/v1/sessions/${sessionId}/artifacts/${id}`;
    Promise.all([
      workbenchJson(url + query, tenantHeaders, { signal: controller.signal }),
      workbenchJson(`${url}/content${query}`, tenantHeaders, {
        signal: controller.signal,
      }),
    ])
      .then(([detail, content]) => {
        const d = parseArtifactDetail(detail);
        if (
          d.artifact.id !== id ||
          d.artifact.version.seriesId !== artifact.version.seriesId
        )
          throw Error('比较基线不匹配');
        if (!controller.signal.aborted)
          setPrevious({
            artifact: d.artifact,
            preview: parseArtifactPreview(content),
          });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '基线不可用');
      });
    return () => controller.abort();
  }, [view, artifact?.id, !!previous, sessionId, query, tenantHeaders]);

  const file =
    preview?.kind === 'changeset'
      ? preview.changeset.files.find((f) => f.path === path)
      : null;
  const bodyText = preview?.kind === 'text' ? preview.text : null;
  const toolResult =
    !!artifact &&
    artifact.provenance.kind === 'legacy_deliverable' &&
    isToolResultExport(artifact.version);
  return (
    <div className={reader.reader} data-document-id={artifactId}>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {!artifact ? (
        <p role="status">{error ? '成果暂不可用。' : '正在读取版本…'}</p>
      ) : (
        <>
          <DocumentToolbar
            title={
              toolResult
                ? artifact.version.fileName.startsWith(
                    'tool-result-web-search-',
                  )
                  ? '搜索资料'
                  : '工具记录'
                : artifact.version.fileName
            }
            downloadUrl={`/api/v1/files/${artifact.object.id}/download?name=${encodeURIComponent(artifact.version.fileName)}`}
            actions={[
              { id: 'catalog', label: '查看所有成果' },
              { id: 'refresh', label: '刷新文件' },
              ...(bodyText !== null
                ? [
                    {
                      id: 'source',
                      label: view === 'source' ? '查看预览' : '查看源文本',
                    },
                  ]
                : []),
              ...(artifact.kind !== 'changeset' &&
              artifact.version.parentVersionId
                ? [
                    {
                      id: 'compare',
                      label: view === 'diff' ? '查看预览' : '与上一版对比',
                    },
                  ]
                : []),
            ]}
            onAction={(id) => {
              if (id === 'catalog') onCatalog();
              if (id === 'source')
                setView((v) => (v === 'source' ? 'preview' : 'source'));
              if (id === 'compare')
                setView((v) => (v === 'diff' ? 'preview' : 'diff'));
              if (id === 'refresh') {
                void refresh(true);
                setPreview(null);
                setPreviewRetry((n) => n + 1);
                void onReload();
              }
            }}
          >
            <DocumentVersions
              objectId={artifact.object.id}
              workspaceId={workspaceId}
              headers={tenantHeaders}
              version={artifact.version.version}
              onSelect={(version) => onSelect(version.id)}
            />
          </DocumentToolbar>
          <div className={reader.content}>
            {artifact.stale ? (
              <p className={styles.muted}>
                正在查看 v{artifact.version.version}。
                <button
                  type="button"
                  onClick={() => onSelect(artifact.latestVersionId)}
                >
                  查看最新版本
                </button>
              </p>
            ) : null}
            {artifact.kind === 'changeset' ? (
              <ChangesetPanel
                key={artifact.id}
                artifact={artifact}
                sessionId={sessionId}
                workspaceId={workspaceId}
                headers={tenantHeaders}
                disabled={busy}
                onContinued={onContinued}
              />
            ) : null}
            {preview?.kind === 'changeset' ? (
              <label>
                提案文件
                <select
                  aria-label="提案文件"
                  className={styles.selector}
                  value={path}
                  onChange={(e) => {
                    setPath(e.target.value);
                  }}
                >
                  {preview.changeset.files.map((f) => (
                    <option key={f.path}>{f.path}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {view === 'diff' &&
            (file ||
              (bodyText !== null && previous?.preview.kind === 'text')) ? (
              <>
                <div className={styles.row}>
                  <label>
                    Diff 布局
                    <select
                      aria-label="Diff 布局"
                      value={mode}
                      onChange={(e) =>
                        setMode(e.target.value as 'split' | 'unified')
                      }
                    >
                      <option value="split">并排</option>
                      <option value="unified">统一</option>
                    </select>
                  </label>
                </div>
                <div className={styles.preview}>
                  <DiffBoundary key={`${artifact.id}/${path}`}>
                    <Suspense fallback={<p>正在加载 Diff…</p>}>
                      <RichDiff
                        key={`${artifact.id}/${path}/${previous?.artifact.id ?? ''}`}
                        path={file?.path ?? artifact.version.fileName}
                        before={
                          file
                            ? (file.before?.text ?? null)
                            : previous?.preview.kind === 'text'
                              ? previous.preview.text
                              : null
                        }
                        after={file ? (file.after?.text ?? null) : bodyText}
                        mode={mode}
                      />
                    </Suspense>
                  </DiffBoundary>
                </div>
                {file ? (
                  <p className={styles.muted}>
                    修改前 {file.before?.checksum.slice(0, 19) ?? '新文件'} →
                    修改后 {file.after?.checksum.slice(0, 19) ?? '删除提案'}
                  </p>
                ) : null}
              </>
            ) : view === 'diff' && bodyText !== null ? (
              <p className={styles.muted}>
                {previous
                  ? '上一版不支持文本对比，可分别下载核对。'
                  : '正在读取上一版基线…'}
              </p>
            ) : null}
            {file ? (
              <details>
                <summary>查看完整前后文本（分页）</summary>
                <label>
                  文本侧
                  <select
                    aria-label="文本侧"
                    value={rawSide}
                    onChange={(e) =>
                      setRawSide(e.target.value as 'before' | 'after')
                    }
                  >
                    <option value="before">修改前</option>
                    <option value="after">修改后</option>
                  </select>
                </label>
                <TextPage
                  key={`${path}/${rawSide}`}
                  text={file[rawSide]?.text ?? ''}
                  label={`${rawSide === 'before' ? '修改前' : '修改后'}文本`}
                />
              </details>
            ) : bodyText !== null && view !== 'diff' ? (
              <DocumentText
                text={bodyText}
                fileName={artifact.version.fileName}
                mediaType={
                  preview?.kind === 'text' ? preview.mediaType : 'text/plain'
                }
                source={view === 'source'}
                toolResult={toolResult}
              />
            ) : preview?.kind === 'image' ? (
              <div className={styles.preview}>
                {/* Static raster only; no remote URL, SVG or HTML insertion. */}
                <NativeImagePreview
                  src={`data:${preview.mediaType};base64,${preview.base64}`}
                  alt={`${artifact.version.fileName} 静态预览`}
                />
              </div>
            ) : preview?.kind === 'pdf' ? (
              <NativePdfPreview base64={preview.base64} />
            ) : preview?.kind === 'office' ? (
              <OfficePreview preview={preview} key={preview.checksum} />
            ) : preview?.kind === 'download_only' ? (
              <div>
                <p className={styles.muted}>{preview.reason}</p>
                {['docx', 'xlsx', 'pptx'].includes(artifact.version.format) && (
                  <button
                    type="button"
                    onClick={() => {
                      setPreview(null);
                      setPreviewRetry((n) => n + 1);
                    }}
                  >
                    重试预览
                  </button>
                )}
              </div>
            ) : !preview ? (
              previewError ? (
                <div role="alert" className={styles.error}>
                  <p>{previewError}</p>
                  <button
                    type="button"
                    onClick={() => setPreviewRetry((n) => n + 1)}
                  >
                    重试预览
                  </button>
                </div>
              ) : (
                <p role="status">正在读取安全预览…</p>
              )
            ) : null}
            {artifact.kind === 'plan' ? (
              <section className={styles.actions} aria-label="计划确认">
                <button
                  type="button"
                  disabled={!ready || artifact.stale || busy || planSent}
                  onClick={() =>
                    void continuePlan({
                      kind: 'plan_review',
                      artifactId,
                      checksum: artifact.object.checksum,
                    })
                  }
                >
                  {planSent ? '计划确认已发送' : '认可本版计划，继续'}
                </button>
                <small>
                  认可计划不等于批准执行。需要调整时，直接在对话中说明。
                </small>
                {notice ? (
                  <p role="status" className={styles.muted}>
                    {notice}
                  </p>
                ) : null}
              </section>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
