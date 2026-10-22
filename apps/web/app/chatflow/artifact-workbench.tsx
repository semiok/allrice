'use client';
import {
  DockLayout,
  type TabId,
  dockPaneIds,
  findPaneContentTab,
  findTabPane,
} from '@deepseek-ai/dsh-client-ui-dockkit';
import {
  FileTypeIcon,
  classifyFileType,
  IconClockOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import moduleUi from './workbench-modules.module.css';
import { GUIDE_KIND, pageAddress } from './dsh-upstream/dock/contract/seed';
import { dockLabels, useNativeDock } from './use-native-dock';
import { WorkspaceFileTree } from './workspace-file-tree';
import { WorkspaceFilePreview } from './workspace-file-preview';
import {
  WorkbenchStart,
  WorkbenchIcon,
  moduleLabels,
  type WorkbenchModule,
} from './workbench-modules';
import { ReferenceSnapshotPreview } from './workbench-reference-preview';
import {
  NativeDocumentPreview,
  hasSourcePreview,
  hasNativeViewport,
} from './native-document-preview';
import { DocumentToolbar, DocumentVersions } from './document-reader';
import { SaveArtifactReference } from './save-artifact-reference';
import reader from './document-reader.module.css';
import { isToolResultExport } from '../../lib/chatflow/document-reader-model';
import { ChangesetPanel } from './changeset-panel';
import {
  memo,
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
  type ReferenceSelection,
  type ArtifactBrowserVerification,
  type ChangesetDocument,
  type ReviewContinuationInput,
} from '@allrice/contracts';
import {
  parseArtifactDetail,
  parseArtifactPreview,
  workbenchJson,
  type ArtifactPreview,
  type ArtifactCursor,
} from '../../lib/chatflow/workbench-model';
import styles from './workbench.module.css';
import { DeliveryCard } from './delivery-card';
import deliveries from './dsh-upstream/deliverables/Deliverables.module.css';
import sidebarUi from './dsh-upstream/dock/SidebarRight.module.css';
import { inputRetry } from '../../lib/chatflow/input-retry';
import { readJson } from './chatflow-utils';
import { AssistantMarkdown } from './assistant-markdown';
import {
  TerminalGuide,
  TerminalIcon,
  TerminalWorkbench,
} from './terminal-workbench';
import {
  closeNativeTerminalTab,
  nativeTerminalRuntime,
  retainNativeTerminalTab,
  retainTerminalOwner,
  terminalContentId,
  terminalPin,
} from './terminal-native';
import type { TerminalIdentity } from './terminal-transport';

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
  desktop?: boolean;
  terminalIdentity?: { organizationId: string; ownerId: string };
  onOpenComputerSettings?: () => void;
  moduleRequest?: {
    kind: WorkbenchModule | 'guide' | 'reference';
    revision: number;
    id?: string;
    title?: string;
  };
  workflowAvailable?: boolean;
  experienceAvailable?: boolean;
  renderModule?: (
    kind: WorkbenchModule,
    active: boolean,
    onOpenFile: (id: string, title: string) => void,
  ) => ReactNode;
  onModuleViewed?: (kind: WorkbenchModule) => void;
  onActiveModule?: (kind: WorkbenchModule | 'schedule' | null) => void;
  open: boolean;
  width: number;
  dockScope: string;
  filesRequest?: number;
  selectionRequest?: number;
  taskRequest?: {
    id: string;
    title: string;
    revision: number;
    kind?: 'scheduleTask' | 'sessionSchedules';
  };
  renderTask?: (taskId: string, active: boolean) => ReactNode;
  renderSessionTasks?: (sessionId: string, active: boolean) => ReactNode;
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
  readOnly?: boolean;
  onContinued?: (runId: string) => void;
  onOpenReference?: (reference: ReferenceSelection) => void;
};

/** Focus-contained narrow panel; keeps the same component mounted when resized. */
export const ArtifactWorkbench = memo(function ArtifactWorkbench(props: Props) {
  const panel = useRef<HTMLElement>(null),
    previousFocus = useRef<HTMLElement | null>(null);
  const close = props.onClose;
  const [terminalTitles, setTerminalTitles] = useState<Record<string, string>>(
    {},
  );
  const terminalIdentity: TerminalIdentity | null =
    props.terminalIdentity && props.sessionId
      ? {
          ...props.terminalIdentity,
          workspaceId: props.workspaceId,
          sessionId: props.sessionId,
        }
      : null;
  const terminalClose = useRef<(id: TabId) => void>(() => {});
  const dock = useNativeDock(
    props.dockScope,
    (id) => {
      terminalClose.current(id);
      return true;
    },
    props.onClose,
    props.desktop ? '开始' : '交付成果',
  );
  terminalClose.current = (id) => {
    const tab = dock.surface.layout.tabs[id];
    if (terminalIdentity && tab?.kind === 'terminal')
      void closeNativeTerminalTab(terminalIdentity, tab.id, tab.contentId);
  };
  const terminalLayout = useRef(dock.surface.layout);
  terminalLayout.current = dock.surface.layout;
  useEffect(() => {
    if (!terminalIdentity) return;
    retainTerminalOwner(terminalIdentity);
    for (const tab of Object.values(dock.surface.layout.tabs)) {
      if (tab.kind !== 'terminal') continue;
      const pin = terminalPin(tab.contentId);
      if (!pin) continue;
      void nativeTerminalRuntime(terminalIdentity, pin)
        .then((runtime) => {
          if (terminalLayout.current.tabs[tab.id]?.contentId === tab.contentId)
            retainNativeTerminalTab(runtime, tab.id, tab.contentId);
        })
        .catch(() => undefined);
    }
  }, [props.dockScope, dock.surface.layout]);
  const fullscreen = props.narrow || dock.surface.layout.mode === 'fullscreen';
  const activeModule = useRef(props.onActiveModule);
  activeModule.current = props.onActiveModule;
  useEffect(() => {
    const layout = dock.surface.layout;
    const pane = layout.nodes[layout.activePaneId];
    const tab =
      pane?.kind === 'pane' && pane.activeTabId
        ? layout.tabs[pane.activeTabId]
        : null;
    activeModule.current?.(
      !props.open || !tab
        ? null
        : ['files', 'experience', 'workflow'].includes(tab.kind)
          ? (tab.kind as WorkbenchModule)
          : ['scheduleTask', 'sessionSchedules'].includes(tab.kind)
            ? 'schedule'
            : null,
    );
  }, [props.open, dock.surface.layout]);
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
    if (props.open) dock.reveal();
  }, [props.open]);
  useEffect(() => {
    if (!props.open || !props.desktop) return;
    for (const paneId of dockPaneIds(dock.surface.layout)) {
      const pane = dock.surface.layout.nodes[paneId];
      const tab =
        pane?.kind === 'pane' && pane.activeTabId
          ? dock.surface.layout.tabs[pane.activeTabId]
          : null;
      if (tab && ['files', 'experience', 'workflow'].includes(tab.kind))
        props.onModuleViewed?.(tab.kind as WorkbenchModule);
    }
  }, [props.open, props.desktop, dock.surface.layout, props.onModuleViewed]);
  const lastModuleRequest = useRef(0);
  useEffect(() => {
    const request = props.moduleRequest;
    if (
      !props.desktop ||
      !request ||
      request.revision === lastModuleRequest.current
    )
      return;
    lastModuleRequest.current = request.revision;
    dock.open(
      request.kind,
      request.id ?? pageAddress(request.kind),
      request.title ??
        (request.kind === 'guide'
          ? '开始'
          : request.kind === 'reference'
            ? '参考资料'
            : moduleLabels[request.kind]),
    );
  });
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
      dock.open(
        GUIDE_KIND,
        pageAddress(GUIDE_KIND),
        props.desktop ? '开始' : '交付成果',
      );
  });
  const lastTaskRequest = useRef(0);
  useEffect(() => {
    const request = props.taskRequest;
    if (!request || lastTaskRequest.current === request.revision) return;
    lastTaskRequest.current = request.revision;
    dock.open(request.kind ?? 'scheduleTask', request.id, request.title);
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
        aria-label={
          props.desktop
            ? '工作台'
            : props.taskRequest
              ? '任务与交付成果'
              : '交付成果'
        }
        aria-modal={fullscreen ? true : undefined}
        data-fullscreen={fullscreen || undefined}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            // Native menus listen on the document. Escape from their anchor
            // must close that menu before it can dismiss the surrounding pane.
            (event.key === 'Escape' &&
              document.querySelector('[role="menu"]')) ||
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
          labels={
            props.desktop
              ? {
                  ...dockLabels,
                  addTab: '新建标签页',
                  emptyPane: '打开文件、经验或工作流',
                }
              : dockLabels
          }
          renderTabTitle={
            props.desktop
              ? (tab) => (
                  <span className={moduleUi.dockTitle}>
                    {['files', 'experience', 'workflow'].includes(tab.kind) ? (
                      <span className={moduleUi[tab.kind]}>
                        <WorkbenchIcon
                          kind={tab.kind as WorkbenchModule}
                          size={17}
                        />
                      </span>
                    ) : ['scheduleTask', 'sessionSchedules'].includes(
                        tab.kind,
                      ) ? (
                      <IconClockOutlineRegular size={17} />
                    ) : tab.kind === 'terminal' ? (
                      <TerminalIcon />
                    ) : tab.kind === GUIDE_KIND ? (
                      <WorkbenchIcon kind="start" size={16} />
                    ) : (
                      <FileTypeIcon
                        kind={classifyFileType(tab.title)}
                        size={16}
                      />
                    )}
                    <span>
                      {tab.kind === GUIDE_KIND
                        ? '开始'
                        : tab.kind === 'terminal'
                          ? (terminalTitles[tab.contentId] ?? tab.title)
                          : tab.title}
                    </span>
                  </span>
                )
              : (tab) => (tab.kind === GUIDE_KIND ? '交付成果' : tab.title)
          }
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
            tab.kind === 'terminal' && terminalIdentity ? (
              <TerminalWorkbench
                identity={terminalIdentity}
                tabId={tab.id}
                contentId={tab.contentId}
                onTitle={(title) =>
                  setTerminalTitles((previous) =>
                    previous[tab.contentId] === title
                      ? previous
                      : { ...previous, [tab.contentId]: title },
                  )
                }
                active={
                  props.open &&
                  findTabPane(dock.surface.layout, tab.id).activeTabId ===
                    tab.id
                }
                onOpenComputerSettings={props.onOpenComputerSettings}
                onNew={() => {
                  void closeNativeTerminalTab(
                    terminalIdentity,
                    tab.id,
                    tab.contentId,
                  );
                  dock.open(
                    GUIDE_KIND,
                    pageAddress(GUIDE_KIND),
                    '开始',
                    findTabPane(dock.surface.layout, tab.id).id,
                    tab.id,
                  );
                }}
              />
            ) : tab.kind === 'sessionSchedules' ? (
              props.renderSessionTasks?.(
                tab.contentId,
                props.open &&
                  findTabPane(dock.surface.layout, tab.id).activeTabId ===
                    tab.id,
              )
            ) : tab.kind === 'scheduleTask' ? (
              props.renderTask?.(
                tab.contentId,
                props.open &&
                  findTabPane(dock.surface.layout, tab.id).activeTabId ===
                    tab.id,
              )
            ) : props.desktop && tab.kind === GUIDE_KIND ? (
              <WorkbenchStart
                experience={!!props.experienceAvailable}
                workflow={!!props.workflowAvailable}
                terminal={
                  terminalIdentity ? (
                    <TerminalGuide
                      identity={terminalIdentity}
                      headers={props.tenantHeaders}
                      active={
                        props.open &&
                        findTabPane(dock.surface.layout, tab.id).activeTabId ===
                          tab.id
                      }
                      readOnly={props.readOnly}
                      onOpenComputerSettings={props.onOpenComputerSettings}
                      onLaunch={(pin, shellPath) => {
                        const count = Object.values(
                          dock.surface.layout.tabs,
                        ).filter((entry) => entry.kind === 'terminal').length;
                        dock.open(
                          'terminal',
                          terminalContentId(pin, shellPath),
                          `终端 ${count + 1}`,
                          findTabPane(dock.surface.layout, tab.id).id,
                          tab.id,
                        );
                      }}
                    />
                  ) : undefined
                }
                onOpen={(kind) => {
                  dock.open(
                    kind,
                    pageAddress(kind),
                    moduleLabels[kind],
                    findTabPane(dock.surface.layout, tab.id).id,
                    tab.id,
                  );
                }}
              />
            ) : props.desktop &&
              ['files', 'experience', 'workflow'].includes(tab.kind) ? (
              props.renderModule?.(
                tab.kind as WorkbenchModule,
                props.open &&
                  findTabPane(dock.surface.layout, tab.id).activeTabId ===
                    tab.id,
                (id, title) =>
                  dock.open(
                    'managedFile',
                    id,
                    title,
                    findTabPane(dock.surface.layout, tab.id).id,
                  ),
              )
            ) : tab.kind === 'reference' ? (
              <ReferenceSnapshotPreview
                revisionId={tab.contentId}
                title={tab.title}
                workspaceId={props.workspaceId}
                headers={props.tenantHeaders}
                active={
                  props.open &&
                  findTabPane(dock.surface.layout, tab.id).activeTabId ===
                    tab.id
                }
              />
            ) : tab.kind === 'files' ? (
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
            ) : tab.kind === 'file' || tab.kind === 'managedFile' ? (
              <WorkspaceFilePreview
                unified={tab.kind === 'managedFile'}
                active={
                  props.open &&
                  findTabPane(dock.surface.layout, tab.id).activeTabId ===
                    tab.id
                }
                objectId={tab.contentId}
                title={tab.title}
                workspaceId={props.workspaceId}
                tenantHeaders={props.tenantHeaders}
                onVersion={(id, title) =>
                  dock.open(
                    tab.kind,
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
                active={
                  props.open &&
                  findTabPane(dock.surface.layout, tab.id).activeTabId ===
                    tab.id
                }
                selectedId={tab.kind === 'artifact' ? tab.contentId : null}
                onCatalog={() =>
                  dock.open(
                    props.desktop ? 'deliverables' : GUIDE_KIND,
                    props.desktop
                      ? pageAddress('deliverables')
                      : pageAddress(GUIDE_KIND),
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
                  {props.desktop ? (
                    <WorkbenchIcon
                      kind={fullscreen ? 'restore' : 'fullscreen'}
                      size={19}
                    />
                  ) : fullscreen ? (
                    '↙'
                  ) : (
                    '⛶'
                  )}
                </button>
              ) : null}
              <button type="button" aria-label="关闭工作台" onClick={close}>
                {props.desktop ? <WorkbenchIcon kind="panel" size={19} /> : '×'}
              </button>
            </>
          }
        />
      </aside>
    </>
  );
});

function ArtifactTabBody(
  props: Props & {
    active: boolean;
    onFiles: () => void;
    onCatalog: () => void;
  },
) {
  const artifactId = props.selectedId;
  if (artifactId && props.sessionId)
    return (
      <div className={reader.reader}>
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
          active={props.active}
          sessionId={props.sessionId}
          workspaceId={props.workspaceId}
          tenantHeaders={props.tenantHeaders}
          onSelect={props.onSelect}
          readOnly={props.readOnly}
          onContinued={props.onContinued}
          onCatalog={props.onCatalog}
          onReload={props.onReload}
          onOpenReference={props.onOpenReference}
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

export function FileOrganizationPreview({
  document,
}: {
  document: ChangesetDocument;
}) {
  const labels = { copy: '复制', move: '移动', rename: '重命名' };
  return (
    <section aria-label="文件整理方案">
      <p>
        按下列版本整理文件；目标位置须为空。复制后保留原文件，移动或重命名逐项记录结果。
      </p>
      <table>
        <thead>
          <tr>
            <th>操作</th>
            <th>原文件</th>
            <th>目标位置</th>
            <th>大小</th>
          </tr>
        </thead>
        <tbody>
          {document.files.map((file) =>
            'organization' in file ? (
              <tr key={file.path}>
                <td>{labels[file.organization.operation]}</td>
                <td>
                  <code>{file.path}</code>
                </td>
                <td>
                  <code>{file.organization.target}</code>
                </td>
                <td>
                  {file.organization.source.sizeBytes.toLocaleString()} 字节
                </td>
              </tr>
            ) : null,
          )}
        </tbody>
      </table>
      <details>
        <summary>核对文件版本</summary>
        {document.files.map((file) =>
          'organization' in file ? (
            <p key={file.path}>
              {file.path}
              <br />
              <small>
                内容 {file.organization.source.checksum}
                <br />
                选定版本 {file.organization.source.version}
              </small>
            </p>
          ) : null,
        )}
      </details>
    </section>
  );
}

/** Shared read-only inspector; deliberately has no feedback, approval, apply or
 * resume callbacks. The server must separately authorize the inspection scope. */
export function ReadOnlyArtifactPreview({
  preview,
}: {
  preview: ArtifactPreview;
}) {
  if (preview.kind !== 'changeset')
    return <NativeDocumentPreview preview={preview} fileName="文件预览" />;
  if (preview.changeset.comparisonScope === 'file_organization')
    return <FileOrganizationPreview document={preview.changeset} />;
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
  return null;
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
  // An empty native deliverables wrapper still contributes its top margin.
  // Mount it only for an actual file, keeping optimistic -> accepted turns still.
  if (!newest.length) return null;
  return (
    <div className={deliveries.root}>
      <div className={deliveries.presented} data-single={newest.length === 1}>
        {newest.map((artifact) => (
          <DeliveryCard key={artifact.id} artifact={artifact} onOpen={onOpen} />
        ))}
      </div>
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
  active,
  artifactId,
  sessionId,
  workspaceId,
  tenantHeaders,
  onSelect,
  onContinued,
  readOnly = false,
  onCatalog,
  onReload,
  onOpenReference,
}: {
  active: boolean;
  artifactId: string;
  sessionId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  onSelect: (id: string) => void;
  readOnly?: boolean;
  onContinued?: (runId: string) => void;
  onCatalog: () => void;
  onReload: () => Promise<void>;
  onOpenReference?: (reference: ReferenceSelection) => void;
}) {
  const [artifact, setArtifact] = useState<WorkbenchArtifact | null>(null),
    [preview, setPreview] = useState<ArtifactPreview | null>(null),
    [browserVerification, setBrowserVerification] =
      useState<ArtifactBrowserVerification | null>(null);
  const [planSent, setPlanSent] = useState(false);
  async function continuePlan(
    review: Extract<ReviewContinuationInput, { kind: 'plan_review' }>,
  ) {
    if (readOnly) return false;
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
    [readError, setReadError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [previewError, setPreviewError] = useState(''),
    [previewRetry, setPreviewRetry] = useState(0);
  const [path, setPath] = useState('');
  const [interactiveHtml, setInteractiveHtml] = useState(false);
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
      if (reset) setReadError('');
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
        setBrowserVerification(result.browserVerification);
        setReadError('');
        setReady(true);
      } catch (cause) {
        if (token === generation.current && !control.signal.aborted) {
          const revoked =
            cause instanceof Error &&
            'status' in cause &&
            [401, 403, 404].includes(Number(cause.status));
          setReadError(
            reset || revoked
              ? cause instanceof Error
                ? cause.message
                : '文件加载失败，请重试。'
              : '文件状态刷新失败，正在显示上次加载的预览。',
          );
          setReady(false);
          if (reset || revoked) {
            setArtifact(null);
            setBrowserVerification(null);
            setPreview(null);
          }
        }
      }
    },
    [endpoint, query, tenantHeaders, artifactId, sessionId],
  );
  useEffect(() => {
    if (!active) return;
    void refresh(true);
    return () => {
      generation.current++;
      pending.current?.abort();
    };
  }, [refresh, active]);
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
    // Immutable document versions need no timer. Only visible mutable reviews
    // refresh their state; native Dock keeps hidden bodies mounted for reading.
    if (!active || !['plan', 'changeset'].includes(artifact?.kind ?? ''))
      return;
    const timer = setInterval(() => {
      if (!busy && document.visibilityState === 'visible') void refresh(false);
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh, busy, active, artifact?.kind]);
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
      {readError ? (
        <div className={styles.error} role="alert">
          {readError}
          <button type="button" onClick={() => void refresh(true)}>
            重试加载文件
          </button>
        </div>
      ) : null}
      {!artifact ? (
        <p role="status">{readError ? '文件暂未加载。' : '正在读取版本…'}</p>
      ) : (
        <>
          <DocumentToolbar
            missingFonts={
              preview?.kind === 'pdf' ? preview.missingFonts : undefined
            }
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
              ...(preview?.kind === 'html'
                ? [
                    {
                      id: 'interactive',
                      label: interactiveHtml ? '切换静态网页' : '切换交互网页',
                    },
                  ]
                : []),
              ...(hasSourcePreview(preview)
                ? [
                    {
                      id: 'source',
                      label: view === 'source' ? '查看预览' : '查看源文本',
                    },
                  ]
                : []),
              ...(artifact.kind !== 'changeset' &&
              preview?.kind === 'text' &&
              preview.eof !== false &&
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
              if (id === 'interactive') {
                setInteractiveHtml((value) => !value);
                setView('preview');
              }
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
            {!readOnly &&
              !toolResult &&
              ['document', 'plan', 'file'].includes(artifact.kind) && (
                <SaveArtifactReference
                  key={artifact.version.id}
                  workspaceId={workspaceId}
                  headers={tenantHeaders}
                  versionId={artifact.version.id}
                  fileName={artifact.version.fileName}
                  version={artifact.version.version}
                />
              )}
          </DocumentToolbar>
          {!!artifact.provenance.referenceReads?.length && (
            <details className={styles.notice}>
              <summary>生成此版本时已检索的资料</summary>
              <p>
                只记录实际返回的片段，不代表已阅读整份文件或采用其中全部内容。
              </p>
              <ul>
                {artifact.provenance.referenceReads.map((read) => (
                  <li key={read.receiptId}>
                    {onOpenReference ? (
                      <button
                        type="button"
                        onClick={() => onOpenReference(read.citation.reference)}
                      >
                        [{read.citation.referenceLabel}] {read.citation.label}
                      </button>
                    ) : (
                      <span>
                        [{read.citation.referenceLabel}] {read.citation.label}
                      </span>
                    )}
                    {' · '}
                    {read.origin.kind === 'explicit'
                      ? '本次选择'
                      : read.origin.kind === 'scene'
                        ? '场景资料'
                        : '常用资料'}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {browserVerification ? (
            <section aria-label="页面验证">
              <p>
                页面验证：
                {
                  { passed: '通过', failed: '未通过', unknown: '未能确认' }[
                    browserVerification.outcome.report.verdict
                  ]
                }
                {' · '}
                {browserVerification.outcome.location === 'local'
                  ? '我的电脑'
                  : '云端隔离环境'}
                {' · '}浏览器已停止
              </p>
              <details>
                <summary>查看验证来源与结果</summary>
                <p>
                  来源：{browserVerification.outcome.report.target.fileName}
                </p>
                <p>
                  版本：{browserVerification.outcome.report.target.versionId}
                </p>
                <p>
                  内容校验：{browserVerification.outcome.report.target.checksum}
                </p>
                <p>浏览器：{browserVerification.outcome.browserVersion}</p>
                <p>
                  已记录 {browserVerification.outcome.report.steps.length}{' '}
                  个步骤。验证期间未重新构建项目。
                </p>
              </details>
            </section>
          ) : null}
          <div
            className={`${reader.content} ${hasNativeViewport(preview) && view === 'preview' ? reader.officeContent : ''}`}
          >
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
                organizationPlan={
                  preview?.kind === 'changeset' &&
                  preview.changeset.comparisonScope === 'file_organization'
                }
                sessionId={sessionId}
                workspaceId={workspaceId}
                headers={tenantHeaders}
                disabled={busy || readOnly}
                onContinued={onContinued}
              />
            ) : null}
            {preview?.kind === 'changeset' &&
            preview.changeset.comparisonScope === 'file_organization' ? (
              <FileOrganizationPreview document={preview.changeset} />
            ) : null}
            {preview?.kind === 'changeset' &&
            preview.changeset.comparisonScope !== 'file_organization' ? (
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
            !(
              preview?.kind === 'changeset' &&
              preview.changeset.comparisonScope === 'file_organization'
            ) &&
            (file ||
              (bodyText !== null &&
                previous?.preview.kind === 'text' &&
                previous.preview.eof !== false)) ? (
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
                  ? '上一版无法完整参与文本对比，可分别下载核对。'
                  : '正在读取上一版基线…'}
              </p>
            ) : null}
            {file && !('organization' in file) ? (
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
            ) : preview && preview.kind !== 'changeset' && view !== 'diff' ? (
              <NativeDocumentPreview
                key={artifact.id}
                active={active}
                preview={preview}
                fileName={artifact.version.fileName}
                pageUrl={`${endpoint}/content${query}`}
                headers={tenantHeaders}
                source={view === 'source'}
                interactive={interactiveHtml}
                toolResult={toolResult}
              />
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
            {artifact.kind === 'plan' && !readOnly ? (
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
