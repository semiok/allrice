'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { isConversationAtBottom } from '../../lib/chatflow/conversation-scroll';

import { ChatComposer } from './chat-composer';
import { ChatSidebar } from './chat-sidebar';
import { ChatTranscript } from './chat-transcript';
import { AttachmentPreviewDialog } from './attachment-preview-dialog';
import type { Attachment, Message } from './chatflow-types';
import {
  employeeForSession,
  providerForSession,
  readJson,
  resizeComposerTextarea,
} from './chatflow-utils';
import { DeliverableVersionHistoryDialog } from './deliverable-version-history-dialog';
import conversationUi from './dsh-upstream/ConversationRoot.module.css';
import frameUi from './dsh-upstream/AppFrame.module.css';
import { DshDialog } from './dsh-upstream/Dialog';
import { EmployeeDetailsDialog } from './employee-details-dialog';
import styles from './dsh-saas.module.css';
import { WorkspaceFilePickerDialog } from './workspace-file-picker-dialog';
import { useAttachments } from './use-attachments';
import { useBridge } from './use-bridge';
import { useRunStream } from './use-run-stream';
import { useSession } from './use-session';

export function ChatFlowClient() {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [employeeDetailsOpen, setEmployeeDetailsOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [imageDragActive, setImageDragActive] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [atTranscriptBottom, setAtTranscriptBottom] = useState(true);
  const conversationScroll = useRef<HTMLDivElement | null>(null);
  const transcriptColumn = useRef<HTMLDivElement | null>(null);
  const followTranscript = useRef(true);
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const dragDepth = useRef(0);

  const scrollToTranscriptBottom = useCallback(() => {
    const scrollRegion = conversationScroll.current;
    if (!scrollRegion) return;
    scrollRegion.scrollTop = scrollRegion.scrollHeight;
    followTranscript.current = true;
    setAtTranscriptBottom(true);
  }, []);

  const {
    activeId,
    createSession,
    history,
    loadHistory,
    loadWorkspace,
    manifest,
    setActiveId,
    setHistory,
    tenantHeaders,
    workspace,
  } = useSession({ setError });

  const {
    loadRunTrace,
    recoverRun,
    resetRunState,
    runTraces,
    runViews,
    streamRun,
  } = useRunStream({
    activeId,
    loadHistory,
    loadWorkspace,
    setError,
    tenantHeaders,
    workspace,
  });

  useEffect(() => {
    if (!activeId) {
      resetRunState();
      setHistory(null);
      return;
    }
    // createSession seeds an authoritative empty History before sendMessage
    // appends the optimistic first turn. Fetching that same Session here races
    // the message POST and can replace the optimistic turn with an empty
    // response, producing a blank active conversation until the next refresh.
    if (history?.session.id === activeId) return;
    followTranscript.current = true;
    setAtTranscriptBottom(true);
    resetRunState();
    loadHistory(activeId).catch((cause) =>
      setError(cause instanceof Error ? cause.message : '会话加载失败'),
    );
  }, [activeId, history?.session.id, loadHistory, resetRunState, setHistory]);

  useEffect(() => {
    const pendingRunIds = (history?.messages ?? [])
      .filter((message) => message.status === 'pending' && message.runId)
      .map((message) => message.runId as string);
    for (const runId of pendingRunIds) {
      void streamRun(runId);
    }
  }, [history, streamRun]);

  useEffect(() => {
    const historicalRunIds = (history?.messages ?? [])
      .filter((message) => message.status !== 'pending')
      .map((message) => message.runId)
      .filter((value): value is string => Boolean(value));
    for (const runId of historicalRunIds) {
      void loadRunTrace(runId);
    }
  }, [history, loadRunTrace]);

  useEffect(() => {
    const scrollRegion = conversationScroll.current;
    if (!scrollRegion) return;
    const handleScroll = () => {
      const atBottom = isConversationAtBottom(scrollRegion);
      followTranscript.current = atBottom;
      setAtTranscriptBottom(atBottom);
    };
    scrollRegion.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => scrollRegion.removeEventListener('scroll', handleScroll);
  }, [activeId, history?.messages.length]);

  useLayoutEffect(() => {
    if (followTranscript.current) scrollToTranscriptBottom();
  }, [history, runViews, scrollToTranscriptBottom]);

  useLayoutEffect(() => {
    resizeComposerTextarea(composerInput.current);
  }, [activeId, draft, history?.messages.length, sidebarCollapsed, workspace]);

  useEffect(() => {
    const textarea = composerInput.current;
    if (!textarea || typeof ResizeObserver === 'undefined') return;

    let previousWidth = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.clientWidth;
      if (nextWidth === previousWidth) return;
      previousWidth = nextWidth;
      resizeComposerTextarea(textarea);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [activeId, history?.messages.length, workspace]);

  useEffect(() => {
    const column = transcriptColumn.current;
    const scrollRegion = conversationScroll.current;
    if (!column || !scrollRegion || typeof ResizeObserver === 'undefined') {
      return;
    }
    const composer = scrollRegion.querySelector<HTMLElement>(
      '[data-composer-seat]',
    );
    const observer = new ResizeObserver(() => {
      if (followTranscript.current) scrollToTranscriptBottom();
    });
    observer.observe(column);
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [activeId, history?.messages.length, scrollToTranscriptBottom]);

  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 760px)');
    const syncSidebar = () => setSidebarCollapsed(mobile.matches);
    syncSidebar();
    mobile.addEventListener('change', syncSidebar);
    return () => mobile.removeEventListener('change', syncSidebar);
  }, []);

  const {
    addWorkspaceFile,
    attachmentPreview,
    clearPendingAttachments,
    deliverableVersions,
    fileInput,
    filePickerOpen,
    openVersionHistory,
    openWorkspaceFiles,
    pendingAttachments,
    persistPendingAttachment,
    removePendingAttachment,
    setAttachmentPreview,
    setFilePickerOpen,
    setPendingAttachments,
    setUploadVisibility,
    setVersionHistoryFile,
    uploadAttachments,
    uploadVisibility,
    versionHistoryFile,
    versionHistoryLoading,
    workspaceFiles,
  } = useAttachments({
    activeId,
    busy,
    createSession: () => createSession(draft),
    setBusy,
    setError,
    tenantHeaders,
    workspace,
  });

  const {
    bridgeBusy,
    bridgeDevices,
    bridgeOpen,
    bridgeRecoveryActive,
    disconnectBridgeWorkspace,
    downloadBridgeClient,
    loadBridgeDevices,
    requestBridgeWorkspaceSelection,
    setBridgeOpen,
  } = useBridge({ setError, tenantHeaders, workspace });

  async function sendMessage() {
    const text = draft.trim();
    if (!workspace || !text || busy) return;
    const draftAttachments = [...pendingAttachments];
    const clientMessageId = crypto.randomUUID();
    const optimisticUserId = `optimistic-user:${clientMessageId}`;
    const optimisticAssistantId = `optimistic-assistant:${clientMessageId}`;
    followTranscript.current = true;
    setAtTranscriptBottom(true);
    setBusy(true);
    setError('');
    try {
      const sessionId = activeId ?? (await createSession(draft));
      if (!sessionId) return;
      const uploadResults = await Promise.allSettled(
        draftAttachments.map((attachment) =>
          persistPendingAttachment(attachment, sessionId),
        ),
      );
      const failedUpload = uploadResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (failedUpload) {
        throw failedUpload.reason instanceof Error
          ? failedUpload.reason
          : new Error('文件上传失败');
      }
      const messageAttachments = uploadResults.map(
        (result) => (result as PromiseFulfilledResult<Attachment>).value,
      );
      setDraft('');
      const createdAt = new Date().toISOString();
      setHistory((current) =>
        current && current.session.id === sessionId
          ? {
              ...current,
              messages: [
                ...current.messages,
                {
                  id: optimisticUserId,
                  role: 'user',
                  content: { text },
                  status: 'completed',
                  runId: null,
                  createdAt,
                  attachments: messageAttachments,
                },
                {
                  id: optimisticAssistantId,
                  role: 'assistant',
                  content: { text: 'Rice 正在处理…' },
                  status: 'pending',
                  runId: null,
                  createdAt,
                },
              ],
            }
          : current,
      );
      const result = await readJson<{
        run: { id: string };
        fallbackRunId: string | null;
        delivery: 'immediate' | 'steer_pending' | 'follow_up';
        userMessage: Message;
        assistantMessage: Message;
      }>(
        await fetch(
          `/api/v1/sessions/${sessionId}/messages?workspaceId=${workspace.workspaceId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({
              clientMessageId,
              text,
              attachmentIds: messageAttachments.map((item) => item.id),
              deliveryMode: 'auto',
            }),
          },
        ),
      );
      clearPendingAttachments();
      const assistantRunId =
        result.delivery === 'immediate' ? result.run.id : result.fallbackRunId;
      setHistory((current) =>
        current && current.session.id === sessionId
          ? {
              ...current,
              messages: current.messages.map((message) =>
                message.id === optimisticUserId
                  ? result.userMessage
                  : message.id === optimisticAssistantId
                    ? {
                        ...result.assistantMessage,
                        runId: assistantRunId,
                      }
                    : message,
              ),
            }
          : current,
      );
      void streamRun(result.run.id);
      void loadHistory(sessionId);
    } catch (cause) {
      setHistory((current) =>
        current
          ? {
              ...current,
              messages: current.messages.filter(
                (message) =>
                  message.id !== optimisticUserId &&
                  message.id !== optimisticAssistantId,
              ),
            }
          : current,
      );
      setDraft(text);
      setError(cause instanceof Error ? cause.message : '消息发送失败');
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun() {
    const targetRun = [...(history?.messages ?? [])]
      .reverse()
      .map((message) => (message.runId ? runViews[message.runId] : undefined))
      .find(
        (view) => view?.status === 'running' || view?.status === 'connecting',
      );
    if (!workspace || !targetRun) return;
    await readJson(
      await fetch(
        `/api/v1/runs/${targetRun.runId}/cancel?workspaceId=${workspace.workspaceId}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...tenantHeaders },
          body: JSON.stringify({ reason: 'user_requested' }),
        },
      ),
    ).catch((cause) =>
      setError(cause instanceof Error ? cause.message : '停止失败'),
    );
  }

  if (!workspace || !manifest) {
    return <main className={styles.loading}>正在进入 AllRice ChatFlow…</main>;
  }

  const sessions = workspace.sessions.filter((session) => !session.archivedAt);
  const activeSession = sessions.find((session) => session.id === activeId);
  const activeEmployee = activeSession
    ? employeeForSession(workspace, activeSession)
    : (workspace.employees.find((employee) => employee.isDefault) ??
      workspace.employees[0]);
  const activeEmployeeProfile = workspace.employeeProfiles.find(
    (profile) => profile.assignmentId === activeEmployee?.id,
  );
  const isRunning = Object.values(runViews).some(
    (view) => view.status === 'running' || view.status === 'connecting',
  );
  const isEmptyConversation =
    !history?.messages.length && Object.keys(runViews).length === 0;
  const recoverableRunView = [...(history?.messages ?? [])]
    .reverse()
    .map((message) => (message.runId ? runViews[message.runId] : undefined))
    .find((view) => view?.status === 'failed' || view?.status === 'canceled');
  const selectedBridgeDevice = bridgeDevices.find(
    (device) => device.status !== 'revoked' && device.folderGrants.length > 0,
  );
  const onlineBridgeDevice = bridgeDevices.find(
    (device) => device.status === 'online',
  );
  const localWorkspaceOnline = selectedBridgeDevice?.status === 'online';
  const localWorkspaceLabel = selectedBridgeDevice?.folderGrants[0]?.label;

  const renderComposer = (hero = false) => (
    <ChatComposer
      attachmentMenuOpen={attachmentMenuOpen}
      busy={busy}
      composerInput={composerInput}
      composing={composing}
      draft={draft}
      error={error}
      fileInput={fileInput}
      hero={hero}
      isRunning={isRunning}
      localWorkspaceLabel={localWorkspaceLabel}
      localWorkspaceOnline={localWorkspaceOnline}
      nativeContextStatus={history?.nativeContextStatus ?? null}
      onAttachmentMenuOpenChange={setAttachmentMenuOpen}
      onCancelRun={cancelRun}
      onDraftChange={setDraft}
      onLoadBridgeDevices={() => loadBridgeDevices(true)}
      onOpenAttachment={setAttachmentPreview}
      onOpenWorkspaceFiles={openWorkspaceFiles}
      onRemoveAttachment={removePendingAttachment}
      onRetryAttachment={(target) => {
        setPendingAttachments((current) =>
          current.map((attachment) =>
            attachment.id === target.id
              ? { ...attachment, status: 'draft', error: undefined }
              : attachment,
          ),
        );
        setError('');
      }}
      onSendMessage={sendMessage}
      onUploadAttachments={uploadAttachments}
      onUploadVisibilityChange={setUploadVisibility}
      pendingAttachments={pendingAttachments}
      providerLabel={providerForSession(workspace, activeSession)}
      uploadVisibility={uploadVisibility}
    />
  );

  return (
    <main
      className={`${frameUi.frame} ${styles.shell}`}
      data-details-collapsed="true"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          dragDepth.current += 1;
          setImageDragActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setImageDragActive(false);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setImageDragActive(false);
        if (!busy) uploadAttachments(event.dataTransfer.files);
      }}
      style={{
        gridTemplateColumns: sidebarCollapsed
          ? '57px minmax(0, 1fr)'
          : '280px minmax(0, 1fr)',
      }}
    >
      {imageDragActive ? (
        <div className={styles.imageDropOverlay}>
          <div>
            <strong>
              {busy ? '当前无法添加图片' : '图片拖动到此处即可添加'}
            </strong>
            {!busy ? <span>最多 20 张，每张 20 MB</span> : null}
          </div>
        </div>
      ) : null}
      <ChatSidebar
        activeEmployeeName={
          activeEmployee?.currentVersion.manifest.name ?? 'Rice'
        }
        activeEmployeeProfileName={activeEmployeeProfile?.name}
        activeId={activeId}
        collapsed={sidebarCollapsed}
        manifest={manifest}
        onCollapsedChange={setSidebarCollapsed}
        onNewSession={() => {
          resetRunState();
          setActiveId(null);
          setHistory(null);
          setDraft('');
          clearPendingAttachments();
        }}
        onOpenEmployeeDetails={() => setEmployeeDetailsOpen(true)}
        onSelectSession={(sessionId) => {
          if (sessionId !== activeId) clearPendingAttachments();
          setActiveId(sessionId);
        }}
        sessions={sessions}
        workspace={workspace}
      />

      <section className={frameUi.centerCol}>
        <div
          className={conversationUi.root}
          data-phase={isEmptyConversation ? 'hero' : 'active'}
        >
          {isEmptyConversation ? (
            <header
              className={`${conversationUi.header} ${conversationUi.headerHidden}`}
            />
          ) : (
            <header
              className={`${conversationUi.header} ${styles.conversationHeader}`}
            >
              <div className={conversationUi.titleRow}>
                <div className={conversationUi.titleCluster}>
                  <div className={conversationUi.crumbs}>
                    <span className={conversationUi.crumbSeg}>
                      <button
                        className={conversationUi.crumb}
                        onClick={() => {
                          resetRunState();
                          setActiveId(null);
                          setHistory(null);
                        }}
                        type="button"
                      >
                        与 Rice 工作
                      </button>
                      <span className={conversationUi.crumbSep}>/</span>
                    </span>
                    <h1>{activeSession?.title ?? '新的工作'}</h1>
                  </div>
                </div>
                <div className={conversationUi.headerActions}>
                  <span className={styles.runtimePill}>
                    <i />
                    {providerForSession(workspace, activeSession)}
                  </span>
                </div>
              </div>
            </header>
          )}

          {isEmptyConversation ? (
            <div className={conversationUi.scrollBody}>
              <section className={styles.emptyStage}>
                <div className={styles.heroStack}>
                  <div className={styles.heroHeadline}>
                    <span className={styles.heroMark}>R</span>
                    <h1>与 Rice 工作</h1>
                    <p>把目标交给 Rice，过程和结果会留在同一个 Session 里。</p>
                  </div>
                  {renderComposer(true)}
                </div>
              </section>
            </div>
          ) : (
            <div
              className={`${conversationUi.scrollBody} ${styles.conversationBody}`}
              data-conversation-scroll
              ref={conversationScroll}
            >
              <div className={conversationUi.viewArea}>
                <ChatTranscript
                  atBottom={atTranscriptBottom}
                  messages={history?.messages ?? []}
                  onLoadRunTrace={loadRunTrace}
                  onRecoverRun={recoverRun}
                  onScrollToBottom={scrollToTranscriptBottom}
                  recoverableRunView={recoverableRunView}
                  runTraces={runTraces}
                  runViews={runViews}
                  tenantHeaders={tenantHeaders}
                  transcriptColumn={transcriptColumn}
                  workspaceId={workspace.workspaceId}
                />
              </div>
              <div
                className={`${conversationUi.composerSeat} ${styles.composerDock}`}
                data-composer-seat
              >
                {renderComposer(false)}
              </div>
            </div>
          )}
        </div>
      </section>

      <AttachmentPreviewDialog
        attachment={attachmentPreview}
        onClose={() => setAttachmentPreview(null)}
      />

      <EmployeeDetailsDialog
        onClose={() => setEmployeeDetailsOpen(false)}
        open={employeeDetailsOpen}
        profile={activeEmployeeProfile ?? null}
      />

      <WorkspaceFilePickerDialog
        files={workspaceFiles}
        onAddFile={addWorkspaceFile}
        onClose={() => setFilePickerOpen(false)}
        onOpenVersionHistory={openVersionHistory}
        open={filePickerOpen}
      />

      <DeliverableVersionHistoryDialog
        file={versionHistoryFile}
        loading={versionHistoryLoading}
        onClose={() => setVersionHistoryFile(null)}
        versions={deliverableVersions}
      />

      {bridgeOpen ? (
        <DshDialog
          ariaLabel="本地工作区状态"
          bodyClassName={styles.bridgeBody}
          className={styles.bridgeDialog}
          eyebrow="Rice Bridge v0.2"
          onClose={() => setBridgeOpen(false)}
          title="本地工作区"
        >
          <div className={styles.bridgeIntro}>
            <p>
              Bridge 只读取你明确授权的文件夹，不开放
              Shell，也不会把模型密钥下发到电脑。
            </p>
            <button
              disabled={bridgeBusy}
              onClick={() => void loadBridgeDevices()}
              type="button"
            >
              刷新状态
            </button>
          </div>
          <div className={styles.bridgeDevices}>
            {bridgeDevices.map((device) => (
              <article key={device.id}>
                <span
                  className={
                    device.status === 'online'
                      ? styles.bridgeOnline
                      : styles.bridgeOffline
                  }
                />
                <div>
                  <strong>{device.name}</strong>
                  <small>
                    {device.status === 'online' ? '在线' : '离线'} · Apple
                    Silicon
                  </small>
                  {device.folderGrants.length ? (
                    <small>
                      本地工作区：
                      {device.folderGrants
                        .map((grant) => grant.label)
                        .join('、')}
                    </small>
                  ) : (
                    <small>尚未选择本地工作区</small>
                  )}
                </div>
                {device.folderGrants.length ? (
                  <button
                    disabled={bridgeBusy}
                    onClick={() => void disconnectBridgeWorkspace(device)}
                    type="button"
                  >
                    断开工作区
                  </button>
                ) : null}
              </article>
            ))}
            {!localWorkspaceOnline ? (
              <section className={styles.bridgeRecovery}>
                <div>
                  <strong>
                    {onlineBridgeDevice
                      ? 'Bridge 在线，工作区未连接'
                      : 'Bridge 当前离线'}
                  </strong>
                  {onlineBridgeDevice ? (
                    <p>
                      点击“选择工作区”后，Snow Mac 会立即弹出 macOS
                      文件夹选择器。选择完成后，这里会自动显示文件夹名称。
                    </p>
                  ) : (
                    <p>
                      请先双击 Snow Mac 桌面的
                      RiceBridge，并保持终端窗口开启；Bridge
                      上线后即可从这里选择工作区。
                    </p>
                  )}
                  <button
                    className={styles.bridgeClientDownload}
                    disabled={bridgeBusy}
                    onClick={() => void downloadBridgeClient()}
                    type="button"
                  >
                    下载支持网页唤起的 RiceBridge v0.2
                  </button>
                </div>
                <button
                  className={styles.bridgeRecoveryPrimary}
                  disabled={bridgeBusy || !onlineBridgeDevice}
                  onClick={() => {
                    if (onlineBridgeDevice) {
                      void requestBridgeWorkspaceSelection(onlineBridgeDevice);
                    }
                  }}
                  type="button"
                >
                  {bridgeRecoveryActive
                    ? '等待本地选择…'
                    : onlineBridgeDevice
                      ? '选择工作区'
                      : '等待 Bridge 上线'}
                </button>
                {bridgeRecoveryActive ? (
                  <small>
                    正在等待你在 Snow Mac
                    完成文件夹选择；选择成功后这里会自动显示文件夹名称。
                  </small>
                ) : null}
              </section>
            ) : null}
          </div>
        </DshDialog>
      ) : null}
    </main>
  );
}
