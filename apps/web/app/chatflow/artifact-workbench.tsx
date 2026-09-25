'use client';
import {
  DockLayout,
  dockPaneIds,
  findPaneContentTab,
  findTabPane,
  type TabId,
} from '@deepseek-ai/dsh-client-ui-dockkit';
import { GUIDE_KIND, pageAddress } from './dsh-upstream/dock/contract/seed';
import { dockLabels, useNativeDock } from './use-native-dock';
import { WorkspaceFileTree } from './workspace-file-tree';
import { WorkspaceFilePreview } from './workspace-file-preview';
import { NativePdfPreview } from './native-pdf-preview';
import { NativeImagePreview } from './native-image-preview';
import { OfficePreview } from './office-preview';
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
  useId,
  useState,
} from 'react';
import {
  ReviewDraftInputSchema,
  ReviewFeedbackSchema,
  type ReviewDraftInput,
  type ReviewFeedback,
  type WorkbenchArtifact,
  type ReviewContinuationInput,
} from '@allrice/contracts';
import {
  artifactKindLabel,
  artifactExecutionLabels,
  parseArtifactDetail,
  parseArtifactPreview,
  reviewAnchorLabel,
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
type Anchor = ReviewDraftInput['comments'][number]['anchor'];
type Props = {
  employeeName?: string;
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
  onDirtyChange?: (value: boolean) => void;
  onContinued?: (runId: string) => void;
};

/** Focus-contained narrow panel; keeps the same component mounted when resized. */
export function ArtifactWorkbench(props: Props) {
  const panel = useRef<HTMLElement>(null),
    dirty = useRef(false),
    previousFocus = useRef<HTMLElement | null>(null);
  const dirtyTabs = useRef(new Set<string>());
  const onDirty = useCallback(
    (id: string, value: boolean) => {
      if (value) dirtyTabs.current.add(id);
      else dirtyTabs.current.delete(id);
      dirty.current = dirtyTabs.current.size > 0;
      props.onDirtyChange?.(dirty.current);
    },
    [props.onDirtyChange],
  );
  const close = useCallback(() => {
    if (
      !dirty.current ||
      window.confirm('有尚未保存的意见，仍要收起成果栏吗？重新打开可继续编辑。')
    )
      props.onClose();
  }, [props.onClose]);
  const dock = useNativeDock(
    props.dockScope,
    (id) =>
      !dirtyTabs.current.has(id) ||
      window.confirm('有尚未保存的意见，关闭会丢失这些本地编辑。仍要关闭吗？'),
    props.onClose,
  );
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
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
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
                workspaceId={props.workspaceId}
                sessionId={props.sessionId ?? 'draft'}
                tabId={tab.id}
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
                tabId={tab.id}
                selectedId={tab.kind === 'artifact' ? tab.contentId : null}
                onDirty={onDirty}
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
  props: Props & {
    tabId: TabId;
    onFiles: () => void;
    onDirty: (id: string, value: boolean) => void;
  },
) {
  const selectorId = useId();
  const artifactId = props.selectedId;
  const dirtyChanged = useCallback(
    (value: boolean) => props.onDirty(props.tabId, value),
    [props.onDirty, props.tabId],
  );
  const select = props.onSelect;
  return (
    <div className={styles.body}>
      {!artifactId ? (
        <button type="button" onClick={props.onFiles}>
          工作区文件
        </button>
      ) : null}
      {props.noticeId && props.noticeId !== artifactId ? (
        <p className={styles.notice} role="status">
          新成果已就绪。
          <button type="button" onClick={() => select(props.noticeId!)}>
            查看新成果
          </button>
        </p>
      ) : null}
      <div className={styles.row}>
        <label htmlFor={selectorId}>成果版本</label>
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
      {!artifactId && props.artifacts.length ? (
        <div className={styles.catalog}>
          {props.artifacts.map((artifact) => (
            <button
              type="button"
              key={artifact.id}
              onClick={() => select(artifact.id)}
            >
              {artifact.version.fileName} · v{artifact.version.version}
            </button>
          ))}
        </div>
      ) : null}
      {artifactId && props.sessionId ? (
        <>
          <select
            id={selectorId}
            className={styles.selector}
            value={artifactId}
            onChange={(e) => select(e.target.value)}
          >
            {!props.artifacts.some((a) => a.id === artifactId) ? (
              <option value={artifactId}>所选版本</option>
            ) : null}
            {props.artifacts.map((a) => (
              <option key={a.id} value={a.id}>
                {artifactKindLabel(a)} · {a.version.fileName} · v
                {a.version.version}
                {a.stale ? '（旧版）' : ''}
              </option>
            ))}
          </select>
          {props.nextCursor ? (
            <button
              type="button"
              disabled={props.listLoading}
              onClick={() => void props.onReload(props.nextCursor!)}
            >
              加载更早成果
            </button>
          ) : null}
          <ArtifactReview
            key={`${props.workspaceId}/${props.sessionId}/${artifactId}`}
            artifactId={artifactId}
            employeeName={props.employeeName}
            sessionId={props.sessionId}
            workspaceId={props.workspaceId}
            tenantHeaders={props.tenantHeaders}
            onDirty={dirtyChanged}
            onSelect={select}
            onContinued={props.onContinued}
          />
        </>
      ) : (
        <p className={styles.muted}>
          {props.listLoading
            ? '正在加载成果…'
            : props.artifacts.length
              ? '选择一份成果开始查看，可在多个标签或分栏中打开。'
              : props.sessionId
                ? '这个会话还没有成果。Rice 交付的报告、文件、修改提案与浏览器证据会显示在这里。'
                : '开始或选择一项工作，交付物将在这里展示。这里不会自动执行命令或批准修改。'}
        </p>
      )}
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
                  onSelect={() => {}}
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

function TextPage({
  text,
  onLine,
  label,
}: {
  text: string;
  onLine?: (line: number) => void;
  label: string;
}) {
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
              {onLine ? (
                <button
                  type="button"
                  aria-label={`评论第 ${current * 100 + i + 1} 行`}
                  onClick={() => onLine(current * 100 + i + 1)}
                >
                  {current * 100 + i + 1}
                </button>
              ) : (
                <span aria-hidden="true">{current * 100 + i + 1} </span>
              )}
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
  employeeName = '当前员工',
  artifactId,
  sessionId,
  workspaceId,
  tenantHeaders,
  onDirty,
  onSelect,
  onContinued,
}: {
  employeeName?: string;
  artifactId: string;
  sessionId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  onDirty: (value: boolean) => void;
  onSelect: (id: string) => void;
  onContinued?: (runId: string) => void;
}) {
  const feedbackId = useId();
  const [artifact, setArtifact] = useState<WorkbenchArtifact | null>(null),
    [feedback, setFeedback] = useState<ReviewFeedback[]>([]),
    [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  async function continueReview(review: ReviewContinuationInput) {
    const key = review.kind === 'plan_review' ? 'plan' : review.feedbackId;
    setBusy(true);
    setError('');
    try {
      const body = {
        text:
          review.kind === 'plan_review'
            ? '认可本版计划并继续'
            : `请${employeeName}根据修改要求修订这份文件`,
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
      setSent((old) => new Set([...old, key]));
      setNotice(`已交给${employeeName}，可在对话中查看修改进展。`);
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
  const [draft, setDraft] = useState<ReviewDraftInput | null>(null),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [previewError, setPreviewError] = useState(''),
    [previewRetry, setPreviewRetry] = useState(0);
  const [text, setText] = useState(''),
    [anchor, setAnchor] = useState<Anchor>({ kind: 'whole' }),
    [path, setPath] = useState('');
  const [view, setView] = useState<'preview' | 'diff'>('preview'),
    [mode, setMode] = useState<'split' | 'unified'>('split'),
    [rawSide, setRawSide] = useState<'before' | 'after'>('after');
  const [previous, setPrevious] = useState<{
      artifact: WorkbenchArtifact;
      preview: ArtifactPreview;
    } | null>(null),
    [ready, setReady] = useState(false);
  const generation = useRef(0),
    composer = useRef<HTMLTextAreaElement>(null),
    dirtyRef = useRef(false),
    pending = useRef<AbortController | null>(null);
  const endpoint = `/api/v1/sessions/${sessionId}/artifacts/${artifactId}`,
    query = `?workspaceId=${workspaceId}`;
  dirtyRef.current = dirty || !!text;
  useEffect(() => {
    onDirty(dirty || !!text);
    return () => onDirty(false);
  }, [dirty, text, onDirty]);
  const resetDraft = (a: WorkbenchArtifact, rows: ReviewFeedback[]) => {
    const saved = [...rows].reverse().find((f) => f.state === 'draft');
    setDraft(
      saved
        ? {
            feedbackId: saved.id,
            artifactId: a.id,
            checksum: saved.checksum,
            expectedRevision: saved.revision,
            comments: saved.comments,
          }
        : {
            feedbackId: crypto.randomUUID(),
            artifactId: a.id,
            checksum: a.object.checksum,
            expectedRevision: 0,
            comments: [],
          },
    );
    setDirty(false);
    setText(saved?.comments.map((comment) => comment.text).join('\n') ?? '');
    setAnchor({ kind: 'whole' });
  };
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
        setFeedback(result.feedback);
        if (reset) resetDraft(result.artifact, result.feedback);
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
  const supportsLines =
    !!file ||
    (!!artifact &&
      bodyText !== null &&
      ['text/plain', 'text/markdown', 'application/json'].includes(
        artifact.object.mediaType,
      ));
  const useLines = useCallback(
    (selectedSide: 'before' | 'after', a: number, b: number) => {
      const target = file?.[selectedSide];
      if (file && target)
        setAnchor({
          kind: 'lines',
          path: file.path,
          side: selectedSide,
          startLine: a,
          endLine: b,
          checksum: target.checksum,
        });
      else if (artifact && supportsLines && selectedSide === 'after')
        setAnchor({
          kind: 'lines',
          path: null,
          side: 'after',
          startLine: a,
          endLine: b,
          checksum: artifact.object.checksum,
        });
      else {
        setNotice('此侧不支持当前版本的行评论，请使用整件意见。');
        return;
      }
      composer.current?.focus();
    },
    [file, artifact?.id, supportsLines],
  );
  const revisionAttempt = useRef<{
    fingerprint: string;
    body: ReviewDraftInput;
  } | null>(null);
  const submittingRevision = useRef(false);
  async function requestRevision() {
    if (
      !draft ||
      !artifact ||
      artifact.stale ||
      !text.trim() ||
      submittingRevision.current
    )
      return;
    submittingRevision.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const fingerprint = JSON.stringify({ text: text.trim(), anchor });
      if (revisionAttempt.current?.fingerprint !== fingerprint) {
        revisionAttempt.current = {
          fingerprint,
          body: ReviewDraftInputSchema.parse({
            ...draft,
            ...(revisionAttempt.current
              ? { feedbackId: crypto.randomUUID(), expectedRevision: 0 }
              : {}),
            comments: [{ id: crypto.randomUUID(), anchor, text: text.trim() }],
          }),
        };
      }
      const body = revisionAttempt.current.body;
      // Both phases reuse stable IDs on a lost response: one feedback, one follow-up task.
      const raw = (await workbenchJson(
        `${endpoint}/feedback${query}`,
        tenantHeaders,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      )) as { feedback: unknown };
      const saved = ReviewFeedbackSchema.parse(raw.feedback);
      if (saved.artifactId !== artifactId || saved.id !== body.feedbackId)
        throw Error('修改要求回执不匹配');
      setFeedback((rows) => [
        ...rows.filter((row) => row.id !== saved.id),
        saved,
      ]);
      const continued = await continueReview({
        kind: 'version_feedback',
        artifactId,
        checksum: saved.checksum,
        feedbackId: saved.id,
      });
      if (continued) {
        setText('');
        setDirty(false);
        setAnchor({ kind: 'whole' });
        setDraft({
          ...body,
          feedbackId: crypto.randomUUID(),
          expectedRevision: 0,
          comments: [],
        });
        revisionAttempt.current = null;
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '修改要求提交失败，请重试。',
      );
    } finally {
      submittingRevision.current = false;
      setBusy(false);
    }
  }
  const canEdit = ready && !artifact?.stale && !busy;
  return (
    <div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {!artifact ? (
        <p role="status">{error ? '成果暂不可用。' : '正在读取版本…'}</p>
      ) : (
        <>
          <h3>{artifact.version.fileName}</h3>
          {artifact.kind === 'changeset' ? (
            <ChangesetPanel
              key={artifact.id}
              artifact={artifact}
              sessionId={sessionId}
              workspaceId={workspaceId}
              headers={tenantHeaders}
              disabled={busy || dirty}
              onContinued={onContinued}
            />
          ) : null}
          <div className={styles.meta}>
            <span className={styles.badge}>
              {artifactKindLabel(artifact)} · v{artifact.version.version}
            </span>
            <span
              className={`${styles.badge} ${artifact.stale ? styles.stale : ''}`}
            >
              {artifact.stale ? '旧版本 · 仅查看' : '当前版本'}
            </span>
          </div>
          {artifact.stale ? (
            <p className={styles.muted}>
              文件已有新版本，旧意见和旧批准不会自动作用于新内容。
              <button
                type="button"
                onClick={() => onSelect(artifact.latestVersionId)}
              >
                查看最新版本
              </button>
            </p>
          ) : null}
          <div className={styles.scope}>
            <p>
              {artifact.kind === 'changeset'
                ? '比较范围：本次 Changeset 提案（不是工作区总 Diff，也不是落盘成功回执）'
                : view === 'diff'
                  ? `比较范围：交付物 v${previous?.artifact.version.version ?? '…'} → v${artifact.version.version}`
                  : '查看范围：这个交付物的精确版本'}
            </p>
            <p>
              {artifact.provenance.kind === 'legacy_deliverable'
                ? '来源：升级前交付物，历史 Run / 执行目标未记录'
                : `来源：${artifact.provenance.kind === 'model_proposal' ? 'Rice 提案' : '工具结果'} · Run ${artifact.provenance.runId?.slice(0, 8)}`}
            </p>
            {artifact.execution ? (
              <p>
                目标：{artifactExecutionLabels(artifact.execution).target}
                {artifact.execution.targetKind === 'rice_bridge' &&
                artifact.execution.deviceId
                  ? ` · ${artifact.execution.deviceId.slice(0, 8)}`
                  : ''}
                <br />
                工作副本：
                {artifactExecutionLabels(artifact.execution).workCopy} · 授权 v
                {artifact.execution.grantVersion}（
                {artifactExecutionLabels(artifact.execution).availability}）
              </p>
            ) : (
              <p>
                存放位置：SaaS 文件库
                {artifact.provenance.kind === 'legacy_deliverable'
                  ? '；历史执行位置未知'
                  : ''}
              </p>
            )}
            <details>
              <summary>版本与基线标识</summary>
              <code>
                成果 {artifact.id}
                <br />
                SHA {artifact.object.checksum}
                <br />
                系列 {artifact.version.seriesId}
                {artifact.execution ? (
                  <>
                    <br />
                    目标 {artifact.execution.targetId}
                    <br />
                    工作副本 {artifact.execution.workCopy.id}
                  </>
                ) : null}
              </code>
            </details>
          </div>
          <div className={styles.row}>
            <a
              href={`/api/v1/files/${artifact.object.id}/download?name=${encodeURIComponent(artifact.version.fileName)}`}
              download
            >
              下载此版本
            </a>
            {artifact.kind !== 'changeset' &&
            artifact.version.parentVersionId ? (
              <button
                type="button"
                onClick={() =>
                  setView((v) => (v === 'diff' ? 'preview' : 'diff'))
                }
              >
                {view === 'diff' ? '查看正文' : '与上一版对比'}
              </button>
            ) : null}
          </div>
          {preview?.kind === 'changeset' ? (
            <label>
              提案文件
              <select
                aria-label="提案文件"
                className={styles.selector}
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setAnchor({ kind: 'whole' });
                }}
              >
                {preview.changeset.files.map((f) => (
                  <option key={f.path}>{f.path}</option>
                ))}
              </select>
            </label>
          ) : null}
          {view === 'diff' &&
          (file || (bodyText !== null && previous?.preview.kind === 'text')) ? (
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
                <span className={styles.muted}>选中同侧行号可定位评论</span>
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
                      onSelect={useLines}
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
                onLine={
                  file[rawSide]
                    ? (line) => useLines(rawSide, line, line)
                    : undefined
                }
              />
            </details>
          ) : bodyText !== null ? (
            <>
              {preview?.kind === 'text' &&
              preview.mediaType === 'text/markdown' ? (
                <SafeDocument text={bodyText} />
              ) : null}
              <details
                open={
                  !(
                    preview?.kind === 'text' &&
                    preview.mediaType === 'text/markdown'
                  )
                }
              >
                <summary>原文与行级审查（分页）</summary>
                <TextPage
                  text={bodyText}
                  label="成果正文（只读文本）"
                  onLine={
                    supportsLines
                      ? (line) => useLines('after', line, line)
                      : undefined
                  }
                />
              </details>
            </>
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
          <section className={styles.feedback} aria-label="版本反馈">
            {artifact.kind === 'plan' ? (
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={!canEdit || dirty || sent.has('plan')}
                  onClick={() =>
                    void continueReview({
                      kind: 'plan_review',
                      artifactId,
                      checksum: artifact.object.checksum,
                    })
                  }
                >
                  {sent.has('plan') ? '计划确认已发送' : '认可本版计划，继续'}
                </button>
                <small>
                  认可计划不等于批准执行。需要修改时，在下方提交意见。
                </small>
              </div>
            ) : null}
            <h3>让{employeeName}修改</h3>
            <p className={styles.muted}>
              告诉我哪里需要调整，修改要求会连同这份文件的 v
              {artifact.version.version} 一起发送。
            </p>
            {anchor.kind !== 'whole' && (
              <p className={styles.muted}>
                已选内容：{reviewAnchorLabel(anchor)}{' '}
                <button
                  type="button"
                  onClick={() => setAnchor({ kind: 'whole' })}
                >
                  取消选择
                </button>
              </p>
            )}
            <label htmlFor={feedbackId} className={styles.hiddenLabel}>
              修改要求
            </label>
            <textarea
              id={feedbackId}
              ref={composer}
              value={text}
              maxLength={4000}
              disabled={!canEdit}
              placeholder="例如：补充最新数据，把结论放在开头…"
              onChange={(event) => setText(event.target.value)}
            />
            <div className={styles.row}>
              <button
                type="button"
                className={styles.primary}
                disabled={!canEdit || !text.trim()}
                onClick={() => void requestRevision()}
              >
                {busy ? '正在提交…' : '提交修改'}
              </button>
            </div>
            {notice ? (
              <p role="status" className={styles.muted}>
                {notice}
              </p>
            ) : null}
          </section>
          <details className={styles.history} aria-label="修改记录">
            <summary>修改记录 · {feedback.length}</summary>
            {feedback.length === 0 ? (
              <p className={styles.muted}>暂无已保存的意见。</p>
            ) : (
              feedback.map((f) => (
                <details key={f.id}>
                  <summary>
                    {f.state === 'draft'
                      ? '草稿'
                      : f.state === 'submitted'
                        ? '已提交 · 待处理'
                        : '已关联回应 · 待复核'}{' '}
                    · {f.comments.length} 条{f.stale ? ' · 旧版本' : ''}
                  </summary>
                  {f.comments.map((c) => (
                    <div className={styles.comment} key={c.id}>
                      <small>{reviewAnchorLabel(c.anchor)}</small>
                      <p>{c.text}</p>
                    </div>
                  ))}
                  {f.state === 'submitted' && !f.stale ? (
                    <button
                      type="button"
                      disabled={!canEdit || dirty || sent.has(f.id)}
                      onClick={() =>
                        void continueReview({
                          kind: 'version_feedback',
                          artifactId,
                          checksum: f.checksum,
                          feedbackId: f.id,
                        })
                      }
                    >
                      {sent.has(f.id) ? '修订请求已发送' : '继续提交修改'}
                    </button>
                  ) : null}
                  {f.state === 'draft' ? (
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => {
                        if (
                          !dirtyRef.current ||
                          window.confirm('切换到已保存草稿，放弃未保存编辑？')
                        ) {
                          setDraft({
                            feedbackId: f.id,
                            artifactId,
                            checksum: f.checksum,
                            expectedRevision: f.revision,
                            comments: f.comments,
                          });
                          setText(
                            f.comments
                              .map((comment) => comment.text)
                              .join('\n'),
                          );
                          setDirty(false);
                          revisionAttempt.current = null;
                        }
                      }}
                    >
                      继续此草稿
                    </button>
                  ) : null}
                  {f.resultArtifactId ? (
                    <>
                      <p>{f.resolution}</p>
                      <button
                        type="button"
                        onClick={() => onSelect(f.resultArtifactId!)}
                      >
                        查看回应版本
                      </button>
                    </>
                  ) : null}
                </details>
              ))
            )}
          </details>
        </>
      )}
    </div>
  );
}
