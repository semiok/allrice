'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { UserQuestionAnswerSubmission } from '@allrice/contracts';

import { isConversationAtBottom } from '../../lib/chatflow/conversation-scroll';
import { projectPendingUserQuestion } from '../../lib/chatflow/user-question-state';

import { ChatComposer } from './chat-composer';
import {
  useInteractionStatus,
  InteractionStatusPanel,
} from './interaction-status';
import { inputRetry } from '../../lib/chatflow/input-retry';
import { ChatSidebar } from './chat-sidebar';
import { ChatTranscript } from './chat-transcript';
import { ArtifactWorkbench } from './artifact-workbench';
import { useArtifactWorkbench } from './use-artifact-workbench';
import workbenchUi from './workbench.module.css';
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
import { projectBridgeView } from './bridge-view';
import { useRunStream } from './use-run-stream';
import { useSession } from './use-session';
import {
  UserQuestionComposer,
  userQuestionAnswerText,
} from './user-question-composer';

export function ChatFlowClient({
  workbenchEnabled = false,
  localCommandsEnabled = false,
  localMcpEnabled = false,
}: {
  workbenchEnabled?: boolean;
  localCommandsEnabled?: boolean;
  localMcpEnabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [inputMode, setInputMode] = useState<'steer' | 'follow_up'>(
    'follow_up',
  );
  const [busy, setBusy] = useState(false);
  const [questionBusy, setQuestionBusy] = useState(false);
  const [error, setError] = useState('');
  const [employeeDetailsOpen, setEmployeeDetailsOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [imageDragActive, setImageDragActive] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workbenchNarrow, setWorkbenchNarrow] = useState(true);
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

  const workbench = useArtifactWorkbench({
    enabled: workbenchEnabled,
    sessionId: activeId,
    workspaceId: workspace?.workspaceId,
    tenantHeaders,
  });
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const sync = () => setWorkbenchNarrow(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  // New completed turns can add artifacts; opening the panel does not execute tools.
  useEffect(() => {
    if (workbenchEnabled) void workbench.reload();
  }, [
    workbenchEnabled,
    history?.messages.length,
    history?.messages.at(-1)?.status,
    workbench.reload,
  ]);

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
    bridgeFeedback,
    bridgeStatusKnown,
    bridgeLastRefreshedAt,
    bridgeRefreshError,
    bridgeOpen,
    bridgePairing,
    bridgePairingBusy,
    bridgeRecoveryActive,
    copyBridgePairingCode,
    createBridgePairing,
    disconnectBridgeWorkspace,
    loadBridgeDevices,
    noteBridgeDownload,
    requestBridgeWorkspaceSelection,
    setBridgeOpen,
  } = useBridge({ setError, tenantHeaders, workspace });

  const interactions = useInteractionStatus(
    workbenchEnabled,
    activeId,
    workspace?.workspaceId,
    tenantHeaders,
  );
  useEffect(() => setInputMode('follow_up'), [activeId]);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!/^(message|operation)-[a-f0-9-]{36}$/.test(hash)) return;
    const scroll = () => {
      const target = document.getElementById(hash);
      if (!target) return false;
      target.scrollIntoView({ block: 'center' });
      return true;
    };
    if (scroll()) return;
    const observer = new MutationObserver(() => {
      if (scroll()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeout = setTimeout(() => observer.disconnect(), 10_000);
    return () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
  }, [history?.session.id, history?.messages.length]);

  async function sendMessage() {
    const text = draft.trim();
    if (!workspace || !text || busy) return;
    const draftAttachments = [...pendingAttachments];
    let clientMessageId = crypto.randomUUID();
    const optimisticUserId = `optimistic-user:${clientMessageId}`;
    const optimisticAssistantId = `optimistic-assistant:${clientMessageId}`;
    followTranscript.current = true;
    setAtTranscriptBottom(true);
    setBusy(true);
    setError('');
    try {
      const sessionId = activeId ?? (await createSession(draft));
      if (!sessionId) return;
      const mode = workbenchEnabled ? inputMode : 'auto';
      const current = interactions.data?.runtime;
      if (mode === 'steer' && (!current?.turnId || current.state !== 'running'))
        throw new Error('当前回合已变化，请刷新后重新选择发送方式。');
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
      const inputBody = {
        text,
        attachmentIds: messageAttachments.map((item) => item.id),
        deliveryMode: mode,
        ...(mode === 'steer'
          ? {
              expectedTurnId: current!.turnId,
              expectedGeneration: current!.generation,
            }
          : {}),
      };
      const retry = await inputRetry(
        `${workspace.organizationId}/${sessionId}`,
        inputBody,
      );
      clientMessageId = retry.id;
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
              ...inputBody,
            }),
          },
        ),
      );
      retry.confirmed();
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
      void interactions.reload();
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

  async function answerUserQuestion(answer: UserQuestionAnswerSubmission) {
    if (!workspace || !activeId || !pendingUserQuestion || questionBusy) return;
    setQuestionBusy(true);
    setError('');
    try {
      const answerBody = {
        text: userQuestionAnswerText(pendingUserQuestion.questions, answer),
        attachmentIds: [],
        deliveryMode: 'steer',
        expectedTurnId: pendingUserQuestion.turnId,
        expectedGeneration: pendingUserQuestion.generation,
        userQuestionAnswer: answer,
      };
      const retry = await inputRetry(
        `${workspace.organizationId}/${activeId}`,
        answerBody,
      );
      const result = await readJson<{
        run: { id: string };
        delivery: 'immediate' | 'steer_pending' | 'follow_up';
      }>(
        await fetch(
          `/api/v1/sessions/${activeId}/messages?workspaceId=${workspace.workspaceId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({
              clientMessageId: retry.id,
              ...answerBody,
            }),
          },
        ),
      );
      if (result.delivery !== 'steer_pending') {
        throw new Error('这个确认请求已经失效，请在聊天框中重新告诉 Rice。');
      }
      await loadHistory(activeId);
      void interactions.reload();
      void streamRun(result.run.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回答提交失败');
    } finally {
      setQuestionBusy(false);
    }
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
  const pendingUserQuestion = Object.values(runViews)
    .filter((view) => view.status === 'running' || view.status === 'connecting')
    .map((view) => projectPendingUserQuestion(view.events))
    .filter((value) => value !== null)
    .sort((left, right) =>
      left.occurredAt === right.occurredAt
        ? left.sequence - right.sequence
        : left.occurredAt.localeCompare(right.occurredAt),
    )
    .at(-1);
  const isEmptyConversation =
    !history?.messages.length && Object.keys(runViews).length === 0;
  const recoverableRunView = [...(history?.messages ?? [])]
    .reverse()
    .map((message) => (message.runId ? runViews[message.runId] : undefined))
    .find((view) => view?.status === 'failed' || view?.status === 'canceled');
  const {
    onlineBridgeDevice,
    localWorkspaceOnline,
    localWorkspaceLabel,
    bridgeConnectionState,
  } = projectBridgeView(bridgeDevices, bridgeStatusKnown);

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
      inputMode={inputMode}
      canSteer={
        interactions.data?.runtime?.state === 'running' && !pendingUserQuestion
      }
      onInputModeChange={workbenchEnabled ? setInputMode : undefined}
      localWorkspaceLabel={localWorkspaceLabel}
      localWorkspaceOnline={localWorkspaceOnline}
      bridgeConnectionState={bridgeConnectionState}
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
      data-details-collapsed={
        !workbench.open || workbenchNarrow ? true : undefined
      }
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
        gridTemplateColumns: `${sidebarCollapsed ? '57px' : '280px'} minmax(0, 1fr)${workbench.open && !workbenchNarrow ? ' minmax(420px, 44%)' : ''}`,
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
          if (!workbench.confirmNavigation()) return;
          resetRunState();
          setActiveId(null);
          setHistory(null);
          setDraft('');
          clearPendingAttachments();
        }}
        onOpenEmployeeDetails={() => setEmployeeDetailsOpen(true)}
        onSelectSession={(sessionId) => {
          if (sessionId !== activeId && !workbench.confirmNavigation()) return;
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
                          if (!workbench.confirmNavigation()) return;
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
                  {workbenchEnabled ? (
                    <button
                      type="button"
                      className={workbenchUi.entry}
                      aria-expanded={workbench.open}
                      onClick={() => {
                        if (!workbench.open) workbench.show();
                        void workbench.reload();
                      }}
                    >
                      ▤ 工件与审查
                      {workbench.artifacts.length
                        ? ` · ${workbench.artifacts.length}`
                        : ''}
                    </button>
                  ) : null}
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
                {workbenchEnabled && activeId ? (
                  <InteractionStatusPanel
                    data={interactions.data}
                    error={interactions.error}
                    sessionId={activeId}
                    onArtifact={(id) => {
                      if (workbench.confirmNavigation()) workbench.show(id);
                    }}
                  />
                ) : null}
                <ChatTranscript
                  atBottom={atTranscriptBottom}
                  localCommandsEnabled={localCommandsEnabled}
                  localMcpEnabled={localMcpEnabled}
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
                  artifacts={workbench.artifacts}
                  onOpenArtifact={(id) => {
                    if (workbench.confirmNavigation()) workbench.show(id);
                  }}
                />
              </div>
              <div
                className={`${conversationUi.composerSeat} ${styles.composerDock}`}
                data-composer-seat
              >
                {pendingUserQuestion ? (
                  <UserQuestionComposer
                    busy={questionBusy}
                    error={error}
                    key={pendingUserQuestion.questionId}
                    onCancelRun={cancelRun}
                    onSubmit={answerUserQuestion}
                    pending={pendingUserQuestion}
                  />
                ) : (
                  renderComposer(false)
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {workbenchEnabled && workbench.open && activeId ? (
        <ArtifactWorkbench
          key={`${workspace.workspaceId}/${activeId}`}
          sessionId={activeId}
          workspaceId={workspace.workspaceId}
          tenantHeaders={tenantHeaders}
          artifacts={workbench.artifacts}
          selectedId={workbench.selectedId}
          nextCursor={workbench.nextCursor}
          listError={workbench.error}
          listLoading={workbench.loading}
          narrow={workbenchNarrow}
          onSelect={(id) => workbench.show(id)}
          onClose={workbench.close}
          onReload={workbench.reload}
          onDirtyChange={workbench.noteDirty}
          onContinued={(runId) => {
            void loadHistory(activeId);
            void streamRun(runId);
            void interactions.reload();
          }}
        />
      ) : null}

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
          eyebrow="Rice Bridge"
          onClose={() => setBridgeOpen(false)}
          title="本地工作区"
        >
          <div className={styles.bridgeIntro}>
            <p>
              Bridge 只访问你明确授权的文件夹；读写能力由员工配置和 Tool Broker
              控制，不开放宿主
              Shell，也不会把模型密钥下发到电脑。新版的本地命令在独立 Linux
              沙箱中执行，需要单独启用及逐次审批。
            </p>
            <button
              disabled={bridgeBusy}
              onClick={() => void loadBridgeDevices()}
              type="button"
            >
              {bridgeBusy ? '正在刷新…' : '刷新状态'}
            </button>
          </div>
          <small role="status" data-bridge-refresh-status>
            {bridgeStatusKnown && bridgeLastRefreshedAt
              ? `状态已刷新 · ${new Date(bridgeLastRefreshedAt).toLocaleTimeString()}`
              : bridgeRefreshError || '尚未取得最新状态，请刷新确认'}
            {' · '}在线状态根据最近 90 秒的设备心跳判断。
          </small>
          <div className={styles.bridgeDownloads}>
            <a
              className={styles.bridgeClientDownload}
              download="RiceBridge-M.zip"
              href="/api/v1/bridge/client/macos-arm64"
              onClick={() => noteBridgeDownload('M 芯片菜单栏版 0.4.0-dev.2')}
            >
              下载 M 芯片版 · 0.4.0-dev.2
            </a>
            <a
              className={styles.bridgeClientDownload}
              download="RiceBridge-Intel.zip"
              href="/api/v1/bridge/client/macos-x64"
              onClick={() =>
                noteBridgeDownload('Intel 芯片菜单栏版 0.4.0-dev.2')
              }
            >
              下载 Intel 芯片版 · 0.4.0-dev.2
            </a>
          </div>
          <p>
            升级前正常退出旧 Bridge，再解压打开 Rice
            Bridge.app；原有配对和工作区会保留。
            新版在菜单栏运行，无需保持终端窗口，可查看状态、选择工作区、暂停和诊断。
            这是尚未 Apple 公证的 Dev 包，不会自动安装沙箱或开放执行权限。
          </p>
          {bridgeFeedback ? (
            <p
              className={styles.bridgeFeedback}
              data-kind={bridgeFeedback.kind}
              role="status"
            >
              {bridgeFeedback.message}
            </p>
          ) : null}
          <div className={styles.bridgeDevices}>
            {bridgeDevices.map((device) => (
              <article key={device.id}>
                <span
                  className={
                    bridgeStatusKnown && device.status === 'online'
                      ? styles.bridgeOnline
                      : styles.bridgeOffline
                  }
                />
                <div>
                  <strong>{device.name}</strong>
                  <small>
                    {!bridgeStatusKnown
                      ? '状态待确认'
                      : device.status === 'online'
                        ? '在线'
                        : '离线'}{' '}
                    ·{' '}
                    {device.platform === 'macos-arm64'
                      ? 'Apple Silicon（M 芯片）'
                      : 'Intel 芯片'}
                  </small>
                  <small>
                    最后心跳：
                    {device.lastSeenAt
                      ? new Date(device.lastSeenAt).toLocaleString()
                      : '尚未收到'}
                  </small>
                  {bridgeStatusKnown && device.status === 'online' ? (
                    device.folderGrants.length ? (
                      <small>
                        本地工作区：
                        {device.folderGrants
                          .map((grant) => grant.label)
                          .join('、')}
                      </small>
                    ) : (
                      <small>尚未选择本地工作区</small>
                    )
                  ) : null}
                </div>
                {bridgeStatusKnown &&
                device.status === 'online' &&
                device.folderGrants.length ? (
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
                    {!bridgeStatusKnown
                      ? 'Bridge 状态待确认'
                      : onlineBridgeDevice
                        ? 'Bridge 在线，工作区未连接'
                        : 'Bridge 当前离线'}
                  </strong>
                  {!bridgeStatusKnown ? (
                    <p>
                      未能取得最新设备状态，不能确认是否在线。请刷新重试，确认后再选择工作区。
                    </p>
                  ) : onlineBridgeDevice ? (
                    <p>
                      点击“选择工作区”后，当前 Mac 会立即弹出 macOS
                      文件夹选择器。选择完成后，这里会自动显示文件夹名称。
                    </p>
                  ) : (
                    <p>
                      下载并解压后打开 Rice Bridge.app，在状态窗口中配对；
                      配对成功后会保存在本机，以后打开即可自动连接。
                    </p>
                  )}
                  <button
                    className={styles.bridgePairingButton}
                    disabled={bridgePairingBusy}
                    onClick={() => void createBridgePairing()}
                    type="button"
                  >
                    {bridgePairingBusy
                      ? '正在生成…'
                      : bridgePairing
                        ? '重新生成配对码'
                        : '生成配对码'}
                  </button>
                  {bridgePairing ? (
                    <div className={styles.bridgePairing}>
                      <strong>配对码</strong>
                      <small>
                        10 分钟内打开解压后的 Rice
                        Bridge.app，在配对窗口中输入：
                      </small>
                      <div className={styles.bridgePairingCode}>
                        <code>{bridgePairing.code.replaceAll('-', '')}</code>
                        <button
                          aria-label="复制配对码"
                          onClick={() =>
                            void copyBridgePairingCode(bridgePairing.code)
                          }
                          title="复制配对码"
                          type="button"
                        >
                          <svg
                            aria-hidden="true"
                            fill="none"
                            viewBox="0 0 24 24"
                          >
                            <rect height="12" rx="2" width="12" x="8" y="8" />
                            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                          </svg>
                        </button>
                      </div>
                      <small>
                        配对成功后授权会安全保存在这台
                        Mac；以后再次打开会自动连接， 不需要重复输入配对码。
                      </small>
                    </div>
                  ) : null}
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
                      : bridgeStatusKnown
                        ? '等待 Bridge 上线'
                        : '等待状态确认'}
                </button>
                {bridgeRecoveryActive ? (
                  <small>
                    正在等待你在当前 Mac
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
