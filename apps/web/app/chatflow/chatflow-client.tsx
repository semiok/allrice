'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { UserQuestionAnswerSubmission } from '@allrice/contracts';
import Link from 'next/link';

import { isConversationAtBottom } from '../../lib/chatflow/conversation-scroll';
import { projectPendingUserQuestion } from '../../lib/chatflow/user-question-state';

import { ChatComposer } from './chat-composer';
import { QueuedMessagesDock } from './queued-messages-dock';
import { AssistantModeControl } from './assistant-mode-control';
import {
  assistantEligibility,
  assistantPreferenceForTask,
} from './assistant-eligibility';
import { useAssistantSession } from './use-assistant-session';
import {
  useInteractionStatus,
  InteractionStatusPanel,
} from './interaction-status';
import { inputRetry } from '../../lib/chatflow/input-retry';
import { ChatSidebar } from './chat-sidebar';
import { EmployeePickerDialog } from './employee-picker-dialog';
import { useMonthlyQuota } from './use-monthly-quota';
import { ChatTranscript } from './chat-transcript';
import { ArtifactWorkbench } from './artifact-workbench';
import { useArtifactWorkbench } from './use-artifact-workbench';
import { useWorkbenchLayout } from './use-workbench-layout';
import { useWorkbenchResize, WorkbenchSplitter } from './workbench-splitter';
import { useWorkspaceReadiness } from './use-workspace-readiness';
import { CapabilityPanel } from './capability-panel';
import { capabilityLabels } from './capability-catalog';
import workbenchUi from './workbench.module.css';
import { AttachmentPreviewDialog } from './attachment-preview-dialog';
import type { Attachment, Message, QueuedMessage } from './chatflow-types';
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
import { createSessionActions } from './session-actions';
import {
  UserQuestionComposer,
  userQuestionAnswerText,
} from './user-question-composer';

export function ChatFlowClient({
  workbenchEnabled = false,
  localCommandsEnabled = false,
  localMcpEnabled = false,
  experienceEnabled = false,
  assistantsEnabled = false,
}: {
  workbenchEnabled?: boolean;
  localCommandsEnabled?: boolean;
  localMcpEnabled?: boolean;
  experienceEnabled?: boolean;
  assistantsEnabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [questionBusy, setQuestionBusy] = useState(false);
  const [error, setError] = useState('');
  const [employeeDetailsOpen, setEmployeeDetailsOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [imageDragActive, setImageDragActive] = useState(false);
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
    captureSelection,
    createSession,
    newSessionEmployee,
    setPendingEmployeeAssignmentId,
    history,
    loadHistory,
    loadWorkspace,
    manifest,
    setActiveId,
    setHistory,
    tenantHeaders,
    workspace,
  } = useSession({ setError });
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [detailsAssignmentId, setDetailsAssignmentId] = useState<string | null>(
    null,
  );
  const monthlyQuota = useMonthlyQuota({
    workspaceId: workspace?.workspaceId,
    organizationId: workspace?.organizationId,
    viewerId: workspace?.viewerId,
    headers: tenantHeaders,
    refreshKey: `${activeId}/${history?.messages.length}/${history?.messages.at(-1)?.status}`,
  });
  const readiness = useWorkspaceReadiness({
    workspaceId: workspace?.workspaceId,
    organizationId: workspace?.organizationId,
    viewerId: workspace?.viewerId,
    sessionId: activeId,
    headers: tenantHeaders,
    visible: capabilitiesOpen,
  });
  const [sessionActions] = useState(() =>
    createSessionActions(captureSelection),
  );
  const selectSession = useCallback(
    (sessionId: string | null) => {
      if (sessionId !== null && captureSelection().sessionId === sessionId)
        return;
      setActiveId(sessionId, sessionId === null);
      setBusy(false);
      setQuestionBusy(false);
      setError('');
    },
    [captureSelection, setActiveId],
  );

  const layout = useWorkbenchLayout({
    viewerId: workspace?.viewerId,
    organizationId: workspace?.organizationId,
    workspaceId: workspace?.workspaceId,
  });
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    narrow: workbenchNarrow,
  } = layout;
  const resize = useWorkbenchResize(
    layout.panelWidth,
    layout.sidebarWidth,
    sidebarCollapsed || layout.compact,
  );
  const workbenchRequested = workbenchEnabled && layout.open;
  const workbenchEntry = useRef<HTMLButtonElement>(null);
  const workbench = useArtifactWorkbench({
    enabled: workbenchEnabled,
    sessionId: activeId,
    workspaceId: workspace?.workspaceId,
    tenantHeaders,
    onOpen: layout.show,
    onClose: layout.close,
    visible: workbenchRequested,
    viewerId: workspace?.viewerId,
  });
  const [filesRequest, setFilesRequest] = useState({ scope: '', revision: 0 });
  const fileScope = `${workspace?.viewerId}/${workspace?.workspaceId}/${activeId ?? 'draft'}`;
  const currentFilesRequest =
    filesRequest.scope === fileScope ? filesRequest.revision : 0;
  const hasWorkbenchContent =
    currentFilesRequest > 0 ||
    workbench.artifacts.length > 0 ||
    workbench.selectedId !== null;
  const workbenchOpen = workbenchRequested && hasWorkbenchContent;
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
    history,
    loadHistory,
    loadWorkspace,
    setError,
    tenantHeaders,
    workspace,
  });

  useEffect(() => {
    if (!activeId) {
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
    loadHistory(activeId).catch((cause) =>
      setError(cause instanceof Error ? cause.message : '会话加载失败'),
    );
  }, [activeId, history?.session.id, loadHistory, setHistory]);

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
    captureSelection,
    sessionActions,
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
  const assistants = useAssistantSession({
    enabled: workbenchEnabled,
    sessionId: activeId,
    workspaceId: workspace?.workspaceId,
    headers: tenantHeaders,
    runRevision: Object.values(runViews)
      .map((view) => `${view.runId}:${view.status}`)
      .join(','),
    hasRunningRun: Object.values(runViews).some(
      (view) => view.status === 'running' || view.status === 'connecting',
    ),
  });
  // Observe server transitions, including another tab's queue and the worker's
  // automatic FIFO release. The browser never dispatches the next task itself.
  const inputRevision = interactions.data?.inputs
    .map((i) => `${i.inputId}:${i.status}`)
    .join(',');
  const runtimeRevision = interactions.data?.runtime?.runId;
  useEffect(() => {
    if (activeId && !busy && inputRevision !== undefined)
      void loadHistory(activeId).catch(() => {});
  }, [activeId, busy, inputRevision, runtimeRevision, loadHistory]);
  const hasQueuedMessages = Boolean(history?.queuedMessages?.length);
  useEffect(() => {
    if (!activeId || !hasQueuedMessages || busy) return;
    const timer = window.setInterval(() => {
      void loadHistory(activeId).catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeId, hasQueuedMessages, busy, loadHistory]);
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
    const action = sessionActions.begin('composer');
    if (!action) return;
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
      if (!activeId && !action.adoptCreatedSession(sessionId)) return;
      if (!action.current()) return;
      const mode = 'follow_up' as const;
      const uploadResults = await Promise.allSettled(
        draftAttachments.map((attachment) =>
          persistPendingAttachment(attachment, sessionId),
        ),
      );
      if (!action.current()) return;
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
      const assistantPreference = assistantPreferenceForTask({
        enabled: assistantsEnabled,
        deliveryMode: mode,
        eligible: assistantAvailability.eligible,
        allowAssistants: true,
      });
      const inputBody = {
        text,
        attachmentIds: messageAttachments.map((item) => item.id),
        deliveryMode: mode,
        ...(assistantPreference ? { assistantPreference } : {}),
      };
      const retry = await inputRetry(
        `${workspace.organizationId}/${sessionId}`,
        inputBody,
      );
      if (!action.current()) return;
      clientMessageId = retry.id;
      setDraft('');
      const createdAt = new Date().toISOString();
      if (!isRunning)
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
                    content: { text: '思考中…' },
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
      if (!action.current()) return;
      clearPendingAttachments();
      setHistory((current) => {
        if (!current || current.session.id !== sessionId) return current;
        const messages = current.messages.filter(
          (m) =>
            ![
              optimisticUserId,
              optimisticAssistantId,
              result.userMessage.id,
              result.assistantMessage.id,
            ].includes(m.id),
        );
        if (result.delivery === 'immediate') {
          return {
            ...current,
            messages: [
              ...messages,
              result.userMessage,
              { ...result.assistantMessage, runId: result.run.id },
            ],
          };
        }
        return {
          ...current,
          messages,
          queuedMessages: [
            ...(current.queuedMessages ?? []).filter(
              (m) => m.id !== result.userMessage.id,
            ),
            {
              id: result.userMessage.id,
              runId: result.fallbackRunId ?? result.run.id,
              text,
              attachments: messageAttachments,
              createdAt: result.userMessage.createdAt,
            },
          ],
        };
      });
      if (result.delivery === 'immediate')
        void streamRun(result.run.id, sessionId);
      void loadHistory(sessionId);
      void interactions.reload();
    } catch (cause) {
      if (!action.current()) return;
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
      if (action.finish()) setBusy(false);
    }
  }

  async function updateQueue(
    item: QueuedMessage,
    kind: 'edit' | 'remove' | 'steer',
  ) {
    if (!workspace || !activeId) return;
    if (kind === 'edit' && (draft.trim() || pendingAttachments.length))
      throw new Error('请先发送或清空当前草稿，再编辑排队消息。');
    const action = sessionActions.begin('composer');
    if (!action) return;
    const sessionId = activeId;
    const scope = captureSelection();
    const target = interactions.data?.runtime;
    setBusy(true);
    setError('');
    try {
      if (kind === 'steer' && (!target?.turnId || target.state !== 'running'))
        throw new Error('当前回合已变化，消息仍保留在队列中。');
      await readJson(
        await fetch(
          `/api/v1/sessions/${sessionId}/queued-messages/${item.id}?workspaceId=${workspace.workspaceId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({
              action: kind,
              ...(kind === 'steer'
                ? {
                    expectedTurnId: target!.turnId,
                    expectedGeneration: target!.generation,
                  }
                : {}),
            }),
          },
        ),
      );
      if (!action.current()) return;
      setHistory((current) =>
        current?.session.id === sessionId
          ? {
              ...current,
              queuedMessages: current.queuedMessages?.filter(
                (m) => m.id !== item.id,
              ),
            }
          : current,
      );
      if (kind === 'edit') {
        setDraft(item.text);
        setPendingAttachments(
          (item.attachments ?? []).map((a) => ({
            ...a,
            persistedId: a.id,
            status: 'ready',
            visibility: uploadVisibility,
          })),
        );
        requestAnimationFrame(() => {
          if (scope.current() && composerInput.current) {
            composerInput.current.focus();
            resizeComposerTextarea(composerInput.current);
          }
        });
      }
      await loadHistory(sessionId);
      void interactions.reload();
    } catch (cause) {
      if (action.current()) {
        void loadHistory(sessionId).catch(() => {});
        throw cause;
      }
    } finally {
      if (action.finish()) setBusy(false);
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
    const scope = captureSelection();
    try {
      await readJson(
        await fetch(
          `/api/v1/runs/${targetRun.runId}/cancel?workspaceId=${workspace.workspaceId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({ reason: 'user_requested' }),
          },
        ),
      );
    } catch (cause) {
      if (scope.current())
        setError(cause instanceof Error ? cause.message : '停止失败');
    }
  }

  async function answerUserQuestion(answer: UserQuestionAnswerSubmission) {
    if (!workspace || !activeId || !pendingUserQuestion || questionBusy) return;
    const action = sessionActions.begin('question');
    if (!action) return;
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
      if (!action.current()) return;
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
      retry.confirmed();
      if (!action.current()) return;
      await loadHistory(activeId);
      if (!action.current()) return;
      void interactions.reload();
      void streamRun(result.run.id, activeId);
    } catch (cause) {
      if (action.current())
        setError(cause instanceof Error ? cause.message : '回答提交失败');
    } finally {
      if (action.finish()) setQuestionBusy(false);
    }
  }

  function confirmSessionNavigation() {
    if (!workbench.confirmNavigation()) return false;
    return (
      !(draft.trim() || pendingAttachments.length) ||
      window.confirm('当前有尚未发送的消息或附件，切换工作会清空它们。继续吗？')
    );
  }
  function startEmployeeSession(assignmentId: string) {
    if (
      !workspace?.employees.some((employee) => employee.id === assignmentId)
    ) {
      setError('这位员工已不在当前工作区，请重新选择。');
      return;
    }
    if (layout.compact) setSidebarCollapsed(true);
    resetRunState();
    selectSession(null);
    setHistory(null);
    setPendingEmployeeAssignmentId(assignmentId);
    setDraft('');
    clearPendingAttachments();
    setEmployeePickerOpen(false);
    requestAnimationFrame(() => composerInput.current?.focus());
  }

  if (!workspace || !manifest) {
    return <main className={styles.loading}>正在进入 AllRice ChatFlow…</main>;
  }

  const sessions = workspace.sessions.filter((session) => !session.archivedAt);
  const activeSession = sessions.find((session) => session.id === activeId);
  const activeEmployee = activeSession
    ? employeeForSession(workspace, activeSession)
    : newSessionEmployee;
  const activeEmployeeProfile = workspace.employeeProfiles.find(
    (profile) => profile.assignmentId === activeEmployee?.id,
  );
  const activeEmployeeName =
    activeEmployee?.versions.find(
      (version) => version.id === activeSession?.employeeVersionId,
    )?.manifest.name ??
    activeEmployee?.currentVersion.manifest.name ??
    activeEmployeeProfile?.name ??
    activeSession?.employeeName ??
    'AI 员工';
  const employeeAssistantAvailability = assistantEligibility({
    enabled: assistantsEnabled,
    sessionId: activeId,
    sessionModels: workspace.sessionModels,
    employee: activeEmployee,
  });
  const assistantReady = readiness.data?.capabilities.find(
    (c) => c.id === 'assistants',
  );
  const assistantAvailability = {
    ...employeeAssistantAvailability,
    eligible:
      employeeAssistantAvailability.eligible &&
      assistantReady?.state === 'ready',
  };
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
    !history?.messages.length &&
    !hasQueuedMessages &&
    Object.keys(runViews).length === 0;
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
      assistantModeControl={
        workbenchEnabled ? (
          <AssistantModeControl
            busy={busy}
            isRunning={isRunning}
            steering={false}
          />
        ) : undefined
      }
      composerInput={composerInput}
      composing={composing}
      draft={draft}
      error={error}
      fileInput={fileInput}
      hero={hero}
      isRunning={isRunning}
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
      ref={resize.frameRef}
      data-dragging={resize.dragging || undefined}
      className={`${frameUi.frame} ${styles.shell}`}
      data-details-collapsed={
        !workbenchOpen || workbenchNarrow ? true : undefined
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
        gridTemplateColumns: `${resize.sidebarWidth}px minmax(0, 1fr)${workbenchOpen && !workbenchNarrow ? ` ${resize.width}px` : ''}`,
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
      {employeePickerOpen && (
        <EmployeePickerDialog
          workspace={workspace}
          onClose={() => setEmployeePickerOpen(false)}
          onSelect={startEmployeeSession}
        />
      )}
      <ChatSidebar
        monthlyQuota={monthlyQuota}
        activeId={activeId}
        collapsed={sidebarCollapsed}
        overlay={layout.compact && !sidebarCollapsed}
        manifest={manifest}
        onCollapsedChange={setSidebarCollapsed}
        onNewSession={(assignmentId) => {
          if (!confirmSessionNavigation()) return;
          if (assignmentId) startEmployeeSession(assignmentId);
          else if (workspace.employees.length === 1)
            startEmployeeSession(workspace.employees[0]!.id);
          else if (workspace.employees.length > 1) setEmployeePickerOpen(true);
          else setError('当前没有可用员工，请先派驻员工。');
        }}
        onOpenEmployeeDetails={(assignmentId) => {
          setDetailsAssignmentId(assignmentId ?? null);
          setEmployeeDetailsOpen(true);
        }}
        onSelectSession={(sessionId) => {
          if (sessionId !== activeId && !confirmSessionNavigation()) return;
          if (layout.compact) setSidebarCollapsed(true);
          if (sessionId !== activeId) {
            clearPendingAttachments();
            setDraft('');
          }
          selectSession(sessionId);
        }}
        sessions={sessions.map((session) =>
          session.id !== activeId
            ? session
            : {
                ...session,
                running: isRunning,
                pendingInteraction: interactions.data?.pendingActions.length
                  ? 'approval'
                  : pendingUserQuestion
                    ? 'question'
                    : undefined,
              },
        )}
        workspace={workspace}
      />

      <section className={frameUi.centerCol}>
        <div
          className={conversationUi.root}
          data-phase={isEmptyConversation ? 'hero' : 'active'}
        >
          {
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
                          if (!confirmSessionNavigation()) return;
                          if (activeEmployee)
                            startEmployeeSession(activeEmployee.id);
                        }}
                        type="button"
                      >
                        与 {activeEmployeeName} 工作
                      </button>
                      <span className={conversationUi.crumbSep}>/</span>
                    </span>
                    <h1>{activeSession?.title ?? '新的工作'}</h1>
                  </div>
                </div>
                <div
                  className={`${conversationUi.headerActions} ${styles.conversationActions}`}
                >
                  <button
                    type="button"
                    className={workbenchUi.entry}
                    aria-haspopup="dialog"
                    onClick={() => setCapabilitiesOpen(true)}
                  >
                    能力与环境
                  </button>
                  {experienceEnabled && workspace ? (
                    <Link
                      className={workbenchUi.entry}
                      href={`/workspace/experience?workspaceId=${encodeURIComponent(workspace.workspaceId)}${activeId ? `&sessionId=${encodeURIComponent(activeId)}` : ''}`}
                    >
                      经验沉淀
                    </Link>
                  ) : null}
                  {workbenchEnabled ? (
                    <button
                      type="button"
                      className={workbenchUi.entry}
                      onClick={() => {
                        setFilesRequest((previous) => ({
                          scope: fileScope,
                          revision: previous.revision + 1,
                        }));
                        workbench.show(undefined, true);
                      }}
                    >
                      工作区文件
                    </button>
                  ) : null}
                  {workbenchEnabled && hasWorkbenchContent ? (
                    <button
                      type="button"
                      ref={workbenchEntry}
                      className={workbenchUi.entry}
                      aria-expanded={workbenchOpen}
                      aria-controls="artifact-workbench"
                      onClick={() => {
                        workbench.show();
                        void workbench.reload();
                      }}
                    >
                      ▤ 交付成果
                      {workbench.artifacts.length
                        ? ` · ${workbench.artifacts.length}`
                        : ''}
                      {workbench.noticeId && !workbenchOpen ? ' · 新成果' : ''}
                    </button>
                  ) : null}
                  <span className={styles.runtimePill}>
                    <i />
                    {providerForSession(workspace, activeSession)}
                  </span>
                </div>
              </div>
            </header>
          }

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
                    onOperation={(id) => {
                      const card = document.getElementById(`operation-${id}`);
                      if (!card) {
                        setError(
                          '动作卡片尚未就绪，请稍候重试；不会代替你批准或重放操作。',
                        );
                        return;
                      }
                      card.tabIndex = -1;
                      card.scrollIntoView({
                        block: 'center',
                        behavior: 'smooth',
                      });
                      card.focus({ preventScroll: true });
                    }}
                  />
                ) : null}
                {workbenchEnabled && assistants.error ? (
                  <p role="status">
                    {assistants.error}{' '}
                    <button type="button" onClick={assistants.reload}>
                      重试助手记录
                    </button>
                  </p>
                ) : null}
                {!workbenchEnabled && interactions.error ? (
                  <p role="status">{interactions.error}</p>
                ) : null}
                {workbenchEnabled && assistants.hasMore ? (
                  <button
                    type="button"
                    onClick={() => void assistants.loadMore()}
                  >
                    加载更早的助手任务记录
                  </button>
                ) : null}
                <ChatTranscript
                  employeeName={activeEmployeeName}
                  atBottom={atTranscriptBottom}
                  localCommandsEnabled={localCommandsEnabled}
                  localMcpEnabled={localMcpEnabled}
                  assistantTrees={assistants.trees}
                  runTimings={interactions.data?.runTimings}
                  onAssistantChanged={assistants.reload}
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
                className={`${conversationUi.composerSeat} ${conversationUi.composerStack} ${styles.composerDock}`}
                data-composer-seat
              >
                <QueuedMessagesDock
                  key={`${workspace.organizationId}/${activeId}`}
                  items={history?.queuedMessages ?? []}
                  busy={busy}
                  canEdit={!draft.trim() && pendingAttachments.length === 0}
                  canSteer={Boolean(
                    interactions.data?.runtime?.turnId &&
                    interactions.data.runtime.state === 'running' &&
                    !pendingUserQuestion,
                  )}
                  updateQueue={updateQueue}
                />
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

      {workbenchOpen ? (
        <ArtifactWorkbench
          selectionRequest={workbench.selectionRequest}
          onBrowseFiles={() => workbench.show(undefined, true)}
          key={`${workspace.viewerId ?? ''}/${workspace.workspaceId}/${activeId}`}
          filesRequest={currentFilesRequest}
          dockScope={`${workspace.organizationId}/${workspace.workspaceId}/${workspace.viewerId ?? 'anonymous'}/${activeId ?? 'draft'}`}
          sessionId={activeId}
          workspaceId={workspace.workspaceId}
          tenantHeaders={tenantHeaders}
          artifacts={workbench.artifacts}
          selectedId={workbench.selectedId}
          nextCursor={workbench.nextCursor}
          listError={workbench.error}
          listLoading={workbench.loading}
          noticeId={workbench.noticeId}
          narrow={workbenchNarrow}
          onSelect={(id) => workbench.show(id)}
          onClose={() => {
            workbench.close();
            workbenchEntry.current?.focus();
          }}
          onReload={workbench.reload}
          onDirtyChange={workbench.noteDirty}
          onContinued={(runId) => {
            if (!activeId) return;
            void loadHistory(activeId);
            void streamRun(runId, activeId);
            void interactions.reload();
          }}
        />
      ) : null}

      {!sidebarCollapsed && !layout.compact ? (
        <WorkbenchSplitter
          key={`sidebar/${workspace.viewerId ?? ''}/${workspace.workspaceId}`}
          side="sidebar"
          width={resize.sidebarWidth}
          min={resize.sidebarMin}
          max={resize.sidebarMax}
          onChange={layout.setSidebarWidth}
          onDraggingChange={resize.setDragging}
        />
      ) : null}

      {workbenchOpen && !workbenchNarrow ? (
        <WorkbenchSplitter
          key={`${workspace.viewerId ?? ''}/${workspace.workspaceId}`}
          width={resize.width}
          min={resize.min}
          max={resize.max}
          onChange={layout.setPanelWidth}
          onDraggingChange={resize.setDragging}
        />
      ) : null}

      <AttachmentPreviewDialog
        attachment={attachmentPreview}
        onClose={() => setAttachmentPreview(null)}
      />
      {capabilitiesOpen ? (
        <CapabilityPanel
          key={`${workspace.viewerId}/${workspace.workspaceId}/${activeId}`}
          data={readiness.data}
          loading={readiness.loading}
          error={readiness.error}
          busy={busy}
          onClose={() => setCapabilitiesOpen(false)}
          onRefresh={() => void readiness.reload()}
          onBridge={() => {
            setCapabilitiesOpen(false);
            void loadBridgeDevices(true);
          }}
          onCompose={(id) => {
            if (
              busy ||
              readiness.data?.capabilities.find((c) => c.id === id)?.state !==
                'ready'
            )
              return;
            const prompt = capabilityLabels[id].prompt;
            if (!prompt) return;
            // Never overwrite an existing draft or send on the user's behalf.
            setDraft((current) =>
              current.trim() ? `${current}\n\n${prompt}` : prompt,
            );
            setCapabilitiesOpen(false);
            requestAnimationFrame(() => composerInput.current?.focus());
          }}
        />
      ) : null}

      <EmployeeDetailsDialog
        onClose={() => setEmployeeDetailsOpen(false)}
        open={employeeDetailsOpen}
        profile={
          workspace.employeeProfiles.find(
            (profile) => profile.assignmentId === detailsAssignmentId,
          ) ??
          activeEmployeeProfile ??
          null
        }
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
          onClose={() => {
            setBridgeOpen(false);
            void readiness.reload();
          }}
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
              onClick={() => noteBridgeDownload('M 芯片菜单栏版 0.5.0-dev.1')}
            >
              下载 M 芯片版 · 0.5.0-dev.1
            </a>
            <a
              className={styles.bridgeClientDownload}
              download="RiceBridge-Intel.zip"
              href="/api/v1/bridge/client/macos-x64"
              onClick={() =>
                noteBridgeDownload('Intel 芯片菜单栏版 0.5.0-dev.1')
              }
            >
              下载 Intel 芯片版 · 0.5.0-dev.1
            </a>
          </div>
          <p>
            升级前正常退出旧 Bridge，再解压打开 Rice
            Bridge.app；原有配对和工作区会保留。
            新版在菜单栏运行，无需保持终端窗口，可查看状态、选择工作区、暂停和诊断，
            以及分别开启独立浏览器和项目预览。新能力默认关闭，仍需服务端配置和逐次审批。
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
