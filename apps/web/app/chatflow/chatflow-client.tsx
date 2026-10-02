'use client';
import { useSessionArchive } from './use-session-archive';
import archiveCss from './session-archive.module.css';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  SessionReference,
  TaskNextStep,
  TaskNextSteps,
  UserQuestionAnswerSubmission,
} from '@allrice/contracts';
import { isMessageRunActive } from './run-view';

import { isConversationAtBottom } from '../../lib/chatflow/conversation-scroll';
import { projectPendingUserQuestion } from '../../lib/chatflow/user-question-state';
import { projectNativeContext } from '../../lib/chatflow/native-context';
import { projectNativeExperience } from '../../lib/chatflow/native-experience';

import { SessionReferencePicker } from './session-reference-picker';
import { ChatComposer } from './chat-composer';
import { CompanyTemplateBrowser } from './company-template-browser';
import { type CompanyDraftReference } from './company-template-use';
import {
  CompanyAssetSchema,
  CompanyAssetRevisionSchema,
} from '@allrice/contracts';
import {
  companyAssetJson,
  companyAssetUrl,
} from './company-template-publisher';
import { AssistantHistoryButton } from './assistant-history-button';
import { WorkspaceStartup } from './workspace-startup';
import { QueuedMessagesDock } from './queued-messages-dock';
import { TaskPlanDock } from './task-plan-dock';
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
import {
  employeeAccent,
  employeeAccentStyle,
  employeeIntroduction,
} from './employee-navigation';
import { useMonthlyQuota } from './use-monthly-quota';
import { usePersonalPreferences } from './use-personal-preferences';
import { MessageFeedbackProvider } from './message-feedback';
import { ChatTranscript } from './chat-transcript';
import { ConversationTurnNavigator } from './conversation-turn-navigator';
import { ArtifactWorkbench } from './artifact-workbench';
import { useArtifactWorkbench } from './use-artifact-workbench';
import { useWorkbenchLayout } from './use-workbench-layout';
import { useWorkbenchResize, WorkbenchSplitter } from './workbench-splitter';
import { useWorkspaceReadiness } from './use-workspace-readiness';
import { useTaskNextSteps } from './use-task-next-steps';
import { CapabilityContent } from './capability-panel';
import { capabilityLabels } from './capability-catalog';
import {
  appendComposerDraft,
  prepareComposerText,
  renderTaskSuggestion,
  type PreparedComposerDraft,
} from '../../lib/chatflow/composer-draft';
import workbenchUi from './workbench.module.css';
import { AttachmentPreviewDialog } from './attachment-preview-dialog';
import type { Attachment, Message, QueuedMessage } from './chatflow-types';
import {
  employeeForSession,
  providerForEmployee,
  providerForSession,
  readJson,
  resizeComposerTextarea,
} from './chatflow-utils';
import { DeliverableVersionHistoryDialog } from './deliverable-version-history-dialog';
import conversationUi from './dsh-upstream/ConversationRoot.module.css';
import frameUi from './dsh-upstream/AppFrame.module.css';
import { EmployeeDetailsDialog } from './employee-details-dialog';
import styles from './dsh-saas.module.css';
import { WorkspaceFilePickerDialog } from './workspace-file-picker-dialog';
import { createMessageImageCache } from './message-image-cache';
import { nextPaint } from './dsh-upstream/images/next-paint';
import { useAttachments } from './use-attachments';
import { useBridge } from './use-bridge';
import { useBridgeReleases } from './bridge-releases';
import { projectBridgeView } from './bridge-view';
import { useRunStream } from './use-run-stream';
import { useSession } from './use-session';
import { createSessionActions } from './session-actions';
import {
  UserQuestionComposer,
  userQuestionAnswerText,
} from './user-question-composer';

// DSH's whole-row disclosures are divs with button semantics, not <button>s.
const transcriptDisclosureSelector =
  'button[aria-expanded], [data-disclosure-row][aria-expanded], summary';

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
  const [companyReferences, setCompanyReferences] = useState<
    CompanyDraftReference[]
  >([]);
  const companyPreparationState = useRef({
    busy: false,
    count: 0,
    taskScope: '',
  });
  const [submission, setSubmission] = useState<{
    scope: string;
    sessionId: string | null;
    queued: boolean;
    user: Message;
    assistant: Message;
    preparing: boolean;
  } | null>(null);
  const [imageCache] = useState(createMessageImageCache);
  const [sessionReferences, setSessionReferences] = useState<
    SessionReference[]
  >([]);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [companyTemplatesScope, setCompanyTemplatesScope] = useState<
    string | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [cancelRequestedRunId, setCancelRequestedRunId] = useState<
    string | null
  >(null);
  const [questionBusy, setQuestionBusy] = useState(false);
  const [error, setError] = useState('');
  const [employeeDetailsOpen, setEmployeeDetailsOpen] = useState(false);
  const [settings, setSettings] = useState<{
    scope: string;
    section: string;
  } | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [imageDragActive, setImageDragActive] = useState(false);
  const [atTranscriptBottom, setAtTranscriptBottom] = useState(true);
  const atTranscriptBottomRef = useRef(true);
  const publishTranscriptBottom = useCallback((value: boolean) => {
    if (atTranscriptBottomRef.current === value) return;
    atTranscriptBottomRef.current = value;
    setAtTranscriptBottom(value);
  }, []);
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
    publishTranscriptBottom(true);
  }, [publishTranscriptBottom]);

  const pauseTranscriptFollowing = useCallback(() => {
    followTranscript.current = false;
    publishTranscriptBottom(false);
  }, [publishTranscriptBottom]);

  const {
    activeId,
    updateSession,
    captureSelection,
    createSession,
    newSessionEmployee,
    setPendingEmployeeAssignmentId,
    history,
    loadHistory,
    loadWorkspace,
    prefetchHistory,
    manifest,
    setActiveId,
    setHistory,
    tenantHeaders,
    workspace,
  } = useSession({ setError });
  const archive = useSessionArchive({
    workspace,
    headers: tenantHeaders,
    onUpdated: updateSession,
    selectedSession:
      history?.session ?? workspace?.sessions.find((s) => s.id === activeId),
  });
  const sessionArchived = Boolean(
    history?.session.archivedAt ??
    workspace?.sessions.find((s) => s.id === activeId)?.archivedAt,
  );
  const settingsScope = `${workspace?.organizationId}/${workspace?.workspaceId}/${workspace?.viewerId}`;
  const imageScope = `${settingsScope}/${activeId}`;
  const messageImages = useMemo(
    () => ({
      load: imageCache.loader(imageScope, tenantHeaders),
      reference: (attachment: Attachment) =>
        imageCache.reference(imageScope, attachment),
    }),
    [imageCache, imageScope, tenantHeaders],
  );
  useEffect(
    () => () => imageCache.release(imageScope),
    [imageCache, imageScope],
  );
  useEffect(() => () => imageCache.dispose(), [imageCache, settingsScope]);
  const visibleSubmission =
    submission?.scope === settingsScope && submission.sessionId === activeId
      ? submission
      : null;
  const transcriptMessages =
    visibleSubmission && !visibleSubmission.queued
      ? [
          ...(history?.messages ?? []),
          visibleSubmission.user,
          ...(visibleSubmission.preparing ? [] : [visibleSubmission.assistant]),
        ]
      : (history?.messages ?? []);
  const queuedMessages = [
    ...(history?.queuedMessages ?? []),
    ...(visibleSubmission?.queued
      ? [
          {
            id: visibleSubmission.user.id,
            runId: '',
            text: visibleSubmission.user.content.text,
            attachments: visibleSubmission.user.attachments,
            sessionReferences: visibleSubmission.user.content.sessionReferences,
            createdAt: visibleSubmission.user.createdAt,
          },
        ]
      : []),
  ];
  useEffect(() => {
    setSessionReferences([]);
    setReferencePickerOpen(false);
    setCompanyReferences([]);
  }, [settingsScope, activeId]);
  const preferences = usePersonalPreferences(workspace, tenantHeaders);
  useEffect(() => {
    setSettings(null);
    if (!workspace?.workspaceId) return;
    const url = new URL(window.location.href);
    const section = url.searchParams.get('settings');
    if (
      !section ||
      !['apps', 'computer', 'capabilities', 'work', 'experience'].includes(
        section,
      )
    )
      return;
    setSettings({ scope: settingsScope, section });
    url.searchParams.delete('settings');
    try {
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
    } catch {
      // Restricted browsers may deny History writes; the modal still opens.
    }
  }, [settingsScope, workspace?.workspaceId]);
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
    visible:
      settings?.scope === settingsScope && settings.section === 'capabilities',
  });
  const [sessionActions] = useState(() =>
    createSessionActions(captureSelection),
  );
  const selectSession = useCallback(
    (sessionId: string | null) => {
      if (sessionId !== null && captureSelection().sessionId === sessionId)
        return;
      setActiveId(sessionId, sessionId === null);
      setSubmission(null);
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
  const resize = useWorkbenchResize(
    layout.panelWidth,
    layout.sidebarWidth,
    sidebarCollapsed || layout.compact,
    workbenchOpen && !workbenchNarrow,
  );
  // New completed turns can add artifacts; opening the panel does not execute tools.
  const artifactHistoryRevision = useRef({ scope: '', revision: '' });
  useEffect(() => {
    const revision = history
      ? `${history.messages.length}/${history.messages.at(-1)?.status}`
      : '';
    const previous = artifactHistoryRevision.current;
    artifactHistoryRevision.current = { scope: workbench.scope, revision };
    // The hook already reads on selection. Don't restart that request when
    // the initial transcript arrives; refresh only subsequent turn changes.
    if (
      workbenchEnabled &&
      previous.scope === workbench.scope &&
      previous.revision &&
      revision &&
      previous.revision !== revision
    )
      void workbench.reload();
  }, [
    workbenchEnabled,
    history?.messages.length,
    history?.messages.at(-1)?.status,
    workbench.reload,
    workbench.scope,
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
    followTranscript.current = true;
    publishTranscriptBottom(true);
  }, [activeId, publishTranscriptBottom]);

  useEffect(() => {
    const scrollRegion = conversationScroll.current;
    if (!scrollRegion) return;
    const handleScroll = () => {
      const atBottom = isConversationAtBottom(scrollRegion);
      // Native virtual rows can emit repeated scroll events during layout.
      // Publish only a change in following state, avoiding nested rerenders.
      if (followTranscript.current === atBottom) return;
      followTranscript.current = atBottom;
      publishTranscriptBottom(atBottom);
    };
    scrollRegion.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => scrollRegion.removeEventListener('scroll', handleScroll);
  }, [activeId, history?.messages.length, publishTranscriptBottom]);

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
    addTaskReferences,
    addWorkspaceFiles,
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
    uploadFromBridge,
    cancelBridgeUpload,
    bridgeUploadStatus,
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

  const nextStepSession =
    history?.session ?? workspace?.sessions.find((s) => s.id === activeId);
  const nextStepEmployee =
    workspace && nextStepSession
      ? employeeForSession(workspace, nextStepSession)
      : newSessionEmployee;
  const nextStepRunRevision = `${history?.messages.at(-1)?.runId}/${history?.messages.at(-1)?.status}/${Object.values(
    runViews,
  )
    .map((v) => `${v.runId}:${v.status}`)
    .join(',')}/${visibleSubmission?.user.id ?? ''}`;
  const nextSteps = useTaskNextSteps({
    organizationId: workspace?.organizationId,
    workspaceId: workspace?.workspaceId,
    viewerId: workspace?.viewerId,
    sessionId: sessionArchived ? null : activeId,
    employeeAssignmentId: nextStepEmployee?.id,
    employeeVersionId: nextStepEmployee?.currentVersion.id,
    runRevision: nextStepRunRevision,
    headers: tenantHeaders,
  });
  const nextStepLifetime = `${settingsScope}/${activeId}/${nextStepEmployee?.id}/${nextStepEmployee?.currentVersion.id}/${nextStepRunRevision}`;
  const nextStepState = useRef({ lifetime: nextStepLifetime, busy });
  nextStepState.current = { lifetime: nextStepLifetime, busy };

  const bridge = useBridge({ setError, tenantHeaders, workspace });
  const {
    bridgeDevices,
    bridgeStatusKnown,
    bridgeOpen,
    loadBridgeDevices,
    setBridgeOpen,
  } = bridge;
  const bridgeReleases = useBridgeReleases(bridgeOpen, tenantHeaders);

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
    if (!workspace || !text || busy || sessionArchived) return;
    const action = sessionActions.begin('composer');
    if (!action) return;
    const draftAttachments = [...pendingAttachments];
    const draftReferences = [...sessionReferences];
    const draftCompanyReferences = [...companyReferences];
    let clientMessageId = crypto.randomUUID();
    const optimisticUserId = `optimistic-user:${clientMessageId}`;
    const optimisticAssistantId = `optimistic-assistant:${clientMessageId}`;
    followTranscript.current = true;
    setAtTranscriptBottom(true);
    setBusy(true);
    setError('');
    const createdAt = new Date().toISOString();
    const echo = {
      scope: settingsScope,
      sessionId: activeId,
      queued: isRunning,
      preparing: true,
      user: {
        id: optimisticUserId,
        role: 'user' as const,
        content: { text, sessionReferences: draftReferences },
        status: 'pending' as const,
        runId: null,
        createdAt,
        attachments: draftAttachments,
      },
      assistant: {
        id: optimisticAssistantId,
        role: 'assistant' as const,
        content: { text: '思考中…' },
        status: 'pending' as const,
        runId: null,
        createdAt,
      },
    };
    // DSH submission echo: paint local previews before any file serialization
    // or network admission. Draft attachment ownership remains available on error.
    setSubmission(echo);
    setDraft('');
    setSessionReferences([]);
    setCompanyReferences([]);
    try {
      await nextPaint();
      if (!action.current()) return;
      const sessionId = activeId ?? (await createSession(text));
      if (!sessionId) throw new Error('创建会话失败，请重试');
      if (!activeId && !action.adoptCreatedSession(sessionId)) return;
      if (!action.current()) return;
      setSubmission({ ...echo, sessionId });
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
        ...(draftCompanyReferences.length
          ? { companyTemplates: draftCompanyReferences.map((r) => r.selection) }
          : {}),
        ...(draftReferences.length
          ? {
              sessionReferenceIds: draftReferences.map(
                (item) => item.sessionId,
              ),
            }
          : {}),
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
      setSubmission({ ...echo, sessionId, preparing: false });
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
      const retainedPreviews = imageCache.handoff(
        `${settingsScope}/${sessionId}`,
        tenantHeaders,
        messageAttachments,
      );
      clearPendingAttachments(retainedPreviews);
      setSubmission(null);
      setSessionReferences([]);
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
              {
                ...result.userMessage,
                attachments: messageAttachments.map((attachment) => ({
                  ...attachment,
                  previewUrl: undefined,
                })),
              },
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
              attachments: messageAttachments.map((attachment) => ({
                ...attachment,
                previewUrl: undefined,
              })),
              sessionReferences: draftReferences,
              companyAssets: result.userMessage.content.companyAssets,
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
      setSubmission(null);
      setDraft(text);
      setSessionReferences(draftReferences);
      setCompanyReferences(draftCompanyReferences);
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
    if (
      kind === 'edit' &&
      (draft.trim() ||
        pendingAttachments.length ||
        sessionReferences.length ||
        companyReferences.length)
    )
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
        setCompanyReferences(
          (item.companyAssets?.templates ?? []).map((t) => ({
            selection: {
              assetId: t.assetId,
              revisionId: t.revision.id,
              digest: t.revision.digest,
              parameters: t.parameters,
            },
            title: t.revision.content.title,
            number: t.revision.number,
          })),
        );
        setSessionReferences(item.sessionReferences ?? []);
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
      .find(
        (message) =>
          message.runId && isMessageRunActive(message, runViews[message.runId]),
      );
    if (
      !workspace ||
      !targetRun?.runId ||
      cancelRequestedRunId === targetRun.runId
    )
      return;
    setCancelRequestedRunId(targetRun.runId);
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
      setCancelRequestedRunId((current) =>
        current === targetRun.runId ? null : current,
      );
    }
  }

  async function answerUserQuestion(answer: UserQuestionAnswerSubmission) {
    if (
      !workspace ||
      !activeId ||
      !pendingUserQuestion ||
      questionBusy ||
      sessionArchived
    )
      return;
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
        throw new Error('这个确认请求已经失效，请在聊天框中重新发送。');
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
    return (
      !(
        draft.trim() ||
        pendingAttachments.length ||
        sessionReferences.length ||
        companyReferences.length
      ) ||
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
    setSessionReferences([]);
    setCompanyReferences([]);
    setReferencePickerOpen(false);
    clearPendingAttachments();
    setEmployeePickerOpen(false);
    requestAnimationFrame(() => composerInput.current?.focus());
  }

  if (!workspace || !manifest) {
    return <WorkspaceStartup error={error} />;
  }

  const sessions = archive.sessions;
  const activeSession = history?.session
    ? {
        ...workspace.sessions.find((s) => s.id === activeId),
        ...archive.sessions.find((s) => s.id === activeId),
        ...history.session,
      }
    : workspace.sessions.find((session) => session.id === activeId);
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
  const activeProviderLabel = activeSession
    ? providerForSession(workspace, activeSession)
    : providerForEmployee(activeEmployee);
  const activeEmployeeColor =
    activeEmployee?.currentVersion.manifest.appearance?.accentColor ??
    activeEmployeeProfile?.appearance?.accentColor;
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
  const activeRunMessages = (history?.messages ?? []).filter(
    (message) =>
      message.runId && isMessageRunActive(message, runViews[message.runId]),
  );
  const isRunning = activeRunMessages.length > 0;
  const nativeContextStatus = projectNativeContext(
    history?.nativeContextStatus ?? null,
    Object.values(runViews).flatMap((view) => view.events),
  );
  const contextCompacting = Object.values(runViews).some(
    (view) =>
      (view.status === 'running' || view.status === 'connecting') &&
      projectNativeExperience(view.events).some(
        (item) =>
          item.kind === 'compaction' &&
          ['started', 'updated'].includes(item.status),
      ),
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
  const historyLoading =
    activeId !== null && history === null && !visibleSubmission;
  const isEmptyConversation =
    !sessionArchived &&
    !historyLoading &&
    !transcriptMessages.length &&
    !hasQueuedMessages &&
    Object.keys(runViews).length === 0;
  const recoverableRunView = [...activeRunMessages]
    .reverse()
    .map((message) => runViews[message.runId!])
    .find((view) => !!view?.connectionError);
  const { localWorkspaceOnline, localWorkspaceLabel, bridgeConnectionState } =
    projectBridgeView(bridgeDevices, bridgeStatusKnown);

  // Like readiness.basis=next_task, use the assignment's effective next version.
  // An existing Session/Run is never rebound merely to display these tasks.
  const suggestionVersion = activeEmployee?.currentVersion;
  const taskScope = `${settingsScope}/${activeId}/${activeEmployee?.id}/${suggestionVersion?.id}`;
  companyPreparationState.current = {
    busy,
    count: companyReferences.length,
    taskScope,
  };
  function prepareDraft(prepared: PreparedComposerDraft) {
    if (busy || composing.current) return;
    const selection = captureSelection();
    let insertion = appendComposerDraft(draft, prepared);
    setDraft((current) => {
      insertion = appendComposerDraft(current, prepared);
      return insertion.text;
    });
    requestAnimationFrame(() => {
      const textarea = composerInput.current;
      if (
        !selection.current() ||
        !textarea ||
        textarea.value !== insertion.text
      )
        return;
      resizeComposerTextarea(textarea);
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(
        insertion.selectionStart,
        insertion.selectionEnd,
      );
    });
  }

  async function prepareNextStep(step: TaskNextStep, snapshot: TaskNextSteps) {
    if (busy || composing.current)
      throw Error('请先完成当前输入，再填写草稿。');
    const selection = captureSelection(),
      lifetime = nextStepLifetime;
    const fresh = await nextSteps.reload(true);
    if (!selection.current() || lifetime !== nextStepState.current.lifetime)
      throw Error('会话或任务已变化，请关闭后重新打开。');
    const currentStep = fresh?.suggestions.find(
      (s) => s.task.id === step.task.id,
    );
    if (
      !fresh ||
      fresh.scope.contextRevision !== snapshot.scope.contextRevision ||
      !currentStep
    )
      throw Error('下一步建议或资料已变化，请关闭后重新打开。');
    if (nextStepState.current.busy || composing.current)
      throw Error('请先完成当前输入，再填写草稿。');
    const prepared = renderTaskSuggestion(currentStep.task);
    if (currentStep.references.length) {
      // Append filenames as literal data after slot rendering. Quoting preserves
      // braces/control characters without interpreting them as template slots.
      prepared.text += `\n\n参考成果：${currentStep.references.map((r) => JSON.stringify(r.fileName)).join('、')}。`;
      prepared.selectionStart = prepared.selectionEnd = prepared.text.length;
    }
    addTaskReferences(currentStep.references);
    prepareDraft(prepared);
  }

  async function prepareCompanyTemplate(reference: CompanyDraftReference) {
    if (!workspace || busy || composing.current || sessionArchived)
      throw Error('请先完成当前输入，再选用范本。');
    const selection = captureSelection();
    const templateScope = taskScope;
    const base = companyAssetUrl('/api/v1/company-assets', {
      workspaceId: workspace.workspaceId,
    });
    const result = (await companyAssetJson(
      companyAssetUrl(base, {
        assetId: reference.selection.assetId,
        history: '1',
      }),
      tenantHeaders,
    )) as {
      asset: unknown;
      revisions: unknown[];
      publishedRevisionIds: string[];
    };
    if (
      !selection.current() ||
      templateScope !== companyPreparationState.current.taskScope ||
      companyPreparationState.current.busy ||
      composing.current
    )
      throw Error('会话或账号已变化，请重新选用。');
    const asset = CompanyAssetSchema.parse(result.asset);
    const revision = result.revisions
      .map((r) => CompanyAssetRevisionSchema.parse(r))
      .find((r) => r.id === reference.selection.revisionId);
    if (
      asset.state !== 'published' ||
      !revision?.file ||
      revision.digest !== reference.selection.digest ||
      !result.publishedRevisionIds.includes(revision.id)
    )
      throw Error('范本已变化、暂停或撤回，请重新选用。');
    if (
      revision.content.appliesToEmployeeIds.length &&
      !revision.content.appliesToEmployeeIds.includes(
        activeEmployee?.employeeId ?? '',
      )
    )
      throw Error('此范本不适用于当前 AI 员工，请选择其他员工。');
    if (
      !companyReferences.some((r) => r.selection.assetId === asset.id) &&
      companyPreparationState.current.count >= 3
    )
      throw Error('一次最多选用 3 项范本，请先移除其他范本。');
    setCompanyReferences((current) => [
      ...current.filter((r) => r.selection.assetId !== asset.id),
      reference,
    ]);
    prepareDraft(
      prepareComposerText(
        `请参考公司范本「${revision.content.title}」v${revision.number}，根据本次填写内容制作新的成果；缺少资料请先向我确认。`,
      ),
    );
    setCompanyTemplatesScope(null);
  }

  const openBridgeSettings = () => {
    setSettings({ scope: settingsScope, section: 'computer' });
    return loadBridgeDevices(true);
  };

  const renderComposer = (hero = false) => (
    <ChatComposer
      taskSuggestions={suggestionVersion?.taskSuggestions ?? []}
      taskScope={taskScope}
      taskNextSteps={nextSteps.data}
      onOpenTasks={() => {
        void nextSteps.reload();
      }}
      onPrepareNextStep={prepareNextStep}
      compact={layout.compact}
      taskReadiness={
        readiness.data?.employeeVersionId === suggestionVersion?.id
          ? readiness.data
          : null
      }
      onPrepareTask={prepareDraft}
      onTaskPreparation={(preparation) => {
        if (preparation === 'files') {
          const selection = captureSelection();
          setAttachmentMenuOpen(true);
          requestAnimationFrame(() => {
            if (selection.current())
              fileInput.current?.parentElement
                ?.querySelector<HTMLButtonElement>(
                  'button[aria-label="添加文件"]',
                )
                ?.focus({ preventScroll: true });
          });
        } else if (preparation === 'bridge') {
          void openBridgeSettings();
        } else setSettings({ scope: settingsScope, section: 'apps' });
      }}
      companyReferences={companyReferences}
      onRemoveCompanyReference={(id) =>
        setCompanyReferences((current) =>
          current.filter((r) => r.selection.assetId !== id),
        )
      }
      sessionReferences={sessionReferences}
      onOpenSessionReferences={() => setReferencePickerOpen(true)}
      onRemoveSessionReference={(id) =>
        setSessionReferences((current) =>
          current.filter((item) => item.sessionId !== id),
        )
      }
      employeeName={activeEmployeeName}
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
      cancelPending={activeRunMessages.some(
        (message) => message.runId === cancelRequestedRunId,
      )}
      localWorkspaceLabel={localWorkspaceLabel}
      localWorkspaceOnline={localWorkspaceOnline}
      bridgeConnectionState={bridgeConnectionState}
      nativeContextStatus={nativeContextStatus}
      contextCompacting={contextCompacting}
      onAttachmentMenuOpenChange={setAttachmentMenuOpen}
      onCancelRun={cancelRun}
      onDraftChange={setDraft}
      onLoadBridgeDevices={openBridgeSettings}
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
      onUploadFromBridge={uploadFromBridge}
      onCancelBridgeUpload={cancelBridgeUpload}
      bridgeUploadStatus={bridgeUploadStatus}
      onUploadVisibilityChange={setUploadVisibility}
      pendingAttachments={
        visibleSubmission
          ? pendingAttachments.filter(
              (file) => !file.mediaType.startsWith('image/'),
            )
          : pendingAttachments
      }
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
        gridTemplateColumns: `${resize.sidebarWidth}px minmax(0, 1fr) ${workbenchOpen && !workbenchNarrow ? resize.width : 0}px`,
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
      {archive.overlays}
      <CompanyTemplateBrowser
        key={settingsScope}
        open={companyTemplatesScope === settingsScope}
        onClose={() => setCompanyTemplatesScope(null)}
        workspaceId={workspace.workspaceId}
        headers={tenantHeaders}
        onPrepare={prepareCompanyTemplate}
      />
      <ChatSidebar
        experienceEnabled={experienceEnabled}
        archive={archive}
        capabilities={
          <CapabilityContent
            key={`capabilities/${workspace.viewerId}/${workspace.workspaceId}/${activeId}`}
            data={readiness.data}
            loading={readiness.loading}
            error={readiness.error}
            busy={busy}
            onRefresh={() => void readiness.reload()}
            onConnections={() => {
              setSettings({ scope: settingsScope, section: 'apps' });
            }}
            onBridge={() => {
              void openBridgeSettings();
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
              prepareDraft(prepareComposerText(prompt));
              setSettings(null);
              if (layout.compact) setSidebarCollapsed(true);
            }}
          />
        }
        settingsSection={
          bridgeOpen
            ? 'computer'
            : settings?.scope === settingsScope
              ? settings.section
              : null
        }
        onSettingsSectionChange={(section) => {
          setBridgeOpen(false);
          if (bridgeOpen) void readiness.reload();
          setSettings(
            section === null ? null : { scope: settingsScope, section },
          );
        }}
        onBridge={() => void openBridgeSettings()}
        bridge={bridge}
        bridgeReleases={bridgeReleases}
        monthlyQuota={monthlyQuota}
        preferences={preferences}
        providerLabel={activeProviderLabel}
        activeId={activeId}
        collapsed={sidebarCollapsed}
        overlay={layout.compact && !sidebarCollapsed}
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
          void loadWorkspace().catch((cause) =>
            setError(
              cause instanceof Error ? cause.message : '员工详情更新失败',
            ),
          );
        }}
        onSelectSession={(sessionId) => {
          if (sessionId !== activeId && !confirmSessionNavigation()) return;
          if (layout.compact) setSidebarCollapsed(true);
          if (sessionId !== activeId) {
            clearPendingAttachments();
            setSessionReferences([]);
            setCompanyReferences([]);
            setReferencePickerOpen(false);
            setDraft('');
          }
          selectSession(sessionId);
        }}
        onPrepareSession={prefetchHistory}
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

      <section
        className={`${frameUi.centerCol} ${styles.employeeConversation}`}
        data-employee-accent={employeeAccent(
          activeEmployeeName,
          activeEmployeeColor,
        )}
        style={employeeAccentStyle(activeEmployeeName, activeEmployeeColor)}
      >
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
                    onClick={() => setCompanyTemplatesScope(settingsScope)}
                  >
                    公司范本
                  </button>
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
                </div>
              </div>
            </header>
          }

          {historyLoading ? (
            <div className={conversationUi.scrollBody}>
              <div
                className={styles.historyLoading}
                role="status"
                aria-live="polite"
              >
                {error || '正在加载会话…'}
                {error ? (
                  <button
                    type="button"
                    onClick={() =>
                      void loadHistory(activeId!).catch((cause) =>
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : '会话加载失败',
                        ),
                      )
                    }
                  >
                    重试
                  </button>
                ) : null}
              </div>
            </div>
          ) : isEmptyConversation ? (
            <div className={conversationUi.scrollBody}>
              <section className={styles.emptyStage}>
                <div className={styles.heroStack}>
                  <div className={styles.heroHeadline}>
                    <span className={styles.heroMark} aria-hidden="true">
                      {activeEmployeeName.slice(0, 1)}
                    </span>
                    <h1>与 {activeEmployeeName} 工作</h1>
                    <p>
                      {employeeIntroduction(
                        activeEmployee,
                        activeEmployeeProfile,
                      )}
                    </p>
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
              <ConversationTurnNavigator
                streamingOutput={preferences.value.streamingOutput}
                key={`turns/${workspace.organizationId}/${workspace.workspaceId}/${workspace.viewerId}/${activeId}`}
                messages={history?.messages ?? []}
                runViews={runViews}
                scrollRef={conversationScroll}
                columnRef={transcriptColumn}
                onNavigateAway={pauseTranscriptFollowing}
              />
              <div
                className={conversationUi.viewArea}
                onClickCapture={(event) => {
                  const target = event.target;
                  if (
                    target instanceof Element &&
                    target.closest(transcriptDisclosureSelector)
                  ) {
                    // Manual disclosure changes are reading actions, not new
                    // output. Pause before React/native details resize so the
                    // bottom-follow observer cannot scroll the trigger away.
                    pauseTranscriptFollowing();
                  }
                }}
                onKeyDownCapture={(event) => {
                  // The native DSH row toggles directly on Enter/Space without
                  // emitting a click, so keyboard expansion needs the same pause.
                  if (
                    (event.key === 'Enter' || event.key === ' ') &&
                    event.target instanceof Element &&
                    event.target.closest(transcriptDisclosureSelector)
                  ) {
                    pauseTranscriptFollowing();
                  }
                }}
              >
                {workbenchEnabled && activeId ? (
                  <InteractionStatusPanel
                    data={interactions.data}
                    error={interactions.error}
                    sessionId={activeId}
                    onArtifact={(id) => {
                      workbench.show(id);
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
                  <AssistantHistoryButton
                    key={activeId}
                    onLoadMore={assistants.loadMore}
                  />
                ) : null}
                <MessageFeedbackProvider
                  readOnly={sessionArchived}
                  key={`feedback/${workspace.organizationId}/${workspace.workspaceId}/${workspace.viewerId}/${activeId}`}
                  sessionId={activeId!}
                  workspaceId={workspace.workspaceId}
                  headers={tenantHeaders}
                >
                  <ChatTranscript
                    streamingOutput={preferences.value.streamingOutput}
                    employeeName={activeEmployeeName}
                    atBottom={atTranscriptBottom}
                    localCommandsEnabled={localCommandsEnabled}
                    localMcpEnabled={localMcpEnabled}
                    assistantTrees={assistants.trees}
                    runTimings={interactions.data?.runTimings}
                    onAssistantChanged={assistants.reload}
                    messages={transcriptMessages}
                    messageImages={messageImages}
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
                      workbench.show(id);
                    }}
                  />
                </MessageFeedbackProvider>
              </div>
              <div
                className={`${conversationUi.composerSeat} ${conversationUi.composerStack} ${styles.composerDock}`}
                data-composer-seat
              >
                <TaskPlanDock
                  sessionId={activeId}
                  history={history}
                  runViews={runViews}
                  runTraces={runTraces}
                  runTimings={interactions.data?.runTimings}
                />
                <QueuedMessagesDock
                  key={`${workspace.organizationId}/${activeId}`}
                  items={sessionArchived ? [] : queuedMessages}
                  busy={busy}
                  canEdit={
                    !draft.trim() &&
                    pendingAttachments.length === 0 &&
                    sessionReferences.length === 0
                  }
                  canSteer={Boolean(
                    interactions.data?.runtime?.turnId &&
                    interactions.data.runtime.state === 'running' &&
                    !pendingUserQuestion,
                  )}
                  updateQueue={updateQueue}
                />
                {sessionArchived ? (
                  <div className={archiveCss.readOnly} role="status">
                    <span>已归档 · 可以查看记录和交付成果</span>
                    {(!activeSession?.ownerId ||
                      activeSession.ownerId === workspace.viewerId) && (
                      <button
                        type="button"
                        onClick={() => activeId && archive.restore(activeId)}
                      >
                        恢复并继续
                      </button>
                    )}
                  </div>
                ) : pendingUserQuestion ? (
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

      {workbenchEnabled && hasWorkbenchContent ? (
        <ArtifactWorkbench
          readOnly={sessionArchived}
          open={workbenchOpen}
          width={resize.width}
          selectionRequest={workbench.selectionRequest}
          onBrowseFiles={() => workbench.show(undefined, true)}
          key={`artifacts/${workspace.viewerId ?? ''}/${workspace.workspaceId}/${activeId}`}
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

      {referencePickerOpen && (
        <SessionReferencePicker
          workspaceId={workspace.workspaceId}
          activeId={activeId}
          headers={tenantHeaders}
          selected={sessionReferences}
          onChange={setSessionReferences}
          onClose={() => {
            setReferencePickerOpen(false);
            composerInput.current?.focus();
          }}
        />
      )}
      <WorkspaceFilePickerDialog
        key={`${workspace.workspaceId}:${activeId ?? 'draft'}`}
        files={workspaceFiles}
        employeeName={activeEmployeeName}
        accentStyle={employeeAccentStyle(
          activeEmployeeName,
          activeEmployeeColor,
        )}
        attachedFileIds={pendingAttachments.map(
          (file) => file.persistedId ?? file.id,
        )}
        onAddFiles={addWorkspaceFiles}
        onClose={() => setFilePickerOpen(false)}
        onOpenVersionHistory={openVersionHistory}
        open={filePickerOpen}
      />

      <DeliverableVersionHistoryDialog
        file={versionHistoryFile}
        loading={versionHistoryLoading}
        onClose={() => {
          setVersionHistoryFile(null);
          setFilePickerOpen(true);
        }}
        versions={deliverableVersions}
      />
    </main>
  );
}
