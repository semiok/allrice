'use client';
import { ReferenceLibrary } from './reference-library';
import { NativeSubagentDirectory } from './native-subagent-directory';
import {
  UnifiedWorkbenchControls,
  announceWorkbenchRead,
} from './unified-workbench-controls';
import type { WorkbenchModule } from './workbench-modules';

import {
  employeeChoices,
  employeeChoice,
  employeeChoiceId,
  employeeChoiceProfile,
} from './employee-instances';
import { useSessionArchive } from './use-session-archive';
import archiveCss from './session-archive.module.css';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from 'react';

import type {
  SessionReference,
  TaskNextStep,
  TaskNextSteps,
  UserQuestionAnswerSubmission,
  EmployeeInstance,
  ReferenceRevision,
} from '@allrice/contracts';
import { isMessageRunActive } from './run-view';

import { isConversationAtBottom } from '../../lib/chatflow/conversation-scroll';
import { projectPendingUserQuestion } from '../../lib/chatflow/user-question-state';
import { projectNativeExperience } from '../../lib/chatflow/native-experience';

import { type ReferenceDraft } from './reference-chips';
import { SessionReferencePicker } from './session-reference-picker';
import { DraftChatComposer } from './chat-composer';
import { createComposerDraftStore } from '../../lib/chatflow/composer-draft-store';
import { type CompanyDraftReference } from './company-template-use';
import {
  CompanyAssetSchema,
  CompanyAssetRevisionSchema,
} from '@allrice/contracts';
import {
  companyAssetJson,
  companyAssetUrl,
} from './company-template-publisher';
import {
  AutomationTaskList,
  AutomationTaskDetail,
  useSessionAutomations,
} from './automation-tasks';
import { WorkspaceStartup } from './workspace-startup';
import { QueuedMessagesDock } from './queued-messages-dock';
import { TaskPlanDock } from './task-plan-dock';
import {
  useInteractionStatus,
  InteractionStatusPanel,
} from './interaction-status';
import { inputRetry } from '../../lib/chatflow/input-retry';
import { isSendReceipt } from './send-receipt';
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
import { InputStatusContext } from './transcript-user-message';
import { ConversationTurnNavigator } from './conversation-turn-navigator';
import { ArtifactWorkbench } from './artifact-workbench';
import { TerminalCleanupStatus } from './terminal-workbench';
import { releaseTerminalOwner } from './terminal-native';
import { useArtifactWorkbench } from './use-artifact-workbench';
import { useWorkbenchLayout } from './use-workbench-layout';
import { useWorkbenchResize, WorkbenchSplitter } from './workbench-splitter';
import { useWorkspaceReadiness } from './use-workspace-readiness';
import { useTaskNextSteps } from './use-task-next-steps';
import { CapabilityContent } from './capability-panel';
import { normalizeSettingsSection } from './sidebar-settings';
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
import { bridgeChips, projectBridgeView } from './bridge-view';
import { useRunStream } from './use-run-stream';
import { useSession } from './use-session';
import { createSessionActions } from './session-actions';
import { useBrandContentWorkspace } from './use-brand-content-workspace';
import {
  UserQuestionComposer,
  userQuestionAnswerText,
} from './user-question-composer';

// DSH's whole-row disclosures are divs with button semantics, not <button>s.
const transcriptDisclosureSelector =
  'button[aria-expanded], [data-disclosure-row][aria-expanded], summary';

const BrandContentPanel = lazy(() =>
  import('./brand-content-panel').then((module) => ({
    default: module.BrandContentPanel,
  })),
);

const WorkbenchFilesPanel = lazy(() =>
  import('./workbench-files-panel').then((module) => ({
    default: module.WorkbenchFilesPanel,
  })),
);
const WorkbenchExperiencePanel = lazy(() =>
  import('./workbench-experience-panel').then((module) => ({
    default: module.WorkbenchExperiencePanel,
  })),
);

export function ChatFlowClient({
  workbenchEnabled = false,
  localCommandsEnabled = false,
  localMcpEnabled = false,
  experienceEnabled = false,
  taskSuggestionsEnabled = false,
}: {
  workbenchEnabled?: boolean;
  localCommandsEnabled?: boolean;
  localMcpEnabled?: boolean;
  experienceEnabled?: boolean;
  taskSuggestionsEnabled?: boolean;
}) {
  const [draftStore] = useState(createComposerDraftStore);
  const setDraft = draftStore.set;
  const hasDraft = useSyncExternalStore(
    draftStore.subscribe,
    draftStore.hasDraft,
    draftStore.hasDraft,
  );
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
  const [referenceSelections, setReferenceSelections] = useState<
    ReferenceDraft[]
  >([]);
  const [referenceToView, setReferenceToView] = useState<ReferenceDraft | null>(
    null,
  );
  const [referenceLibraryOpen, setReferenceLibraryOpen] = useState(false);
  const [recommendedTemplates, setRecommendedTemplates] = useState(false);
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
    registerEmployeeInstance,
    newSessionEmployee,
    setPendingEmployeeAssignmentId,
    history,
    historyStale,
    loadHistory,
    loadWorkspace,
    prefetchHistory,
    manifest,
    refreshHistory,
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
  useEffect(() => {
    if (!workspace?.viewerId) return;
    const owner = {
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      ownerId: workspace.viewerId,
    };
    return () => {
      void releaseTerminalOwner(owner);
    };
  }, [workspace?.organizationId, workspace?.workspaceId, workspace?.viewerId]);
  const [automationNavigation, setAutomationNavigation] = useState<{
    scope: string;
    view: 'catalog' | 'create';
  } | null>(null);
  const automationsOpen =
    automationNavigation?.scope === settingsScope &&
    automationNavigation.view === 'catalog';
  const automationCreate =
    automationNavigation?.scope === settingsScope &&
    automationNavigation.view === 'create';
  const [automationRequest, setAutomationRequest] = useState<{
    scope: string;
    id: string;
    title: string;
    revision: number;
    kind?: 'scheduleTask' | 'sessionSchedules';
    sourceSessionId?: string;
  } | null>(null);
  const currentAutomationRequest =
    automationRequest?.scope === settingsScope &&
    (!automationRequest.sourceSessionId ||
      automationRequest.sourceSessionId === activeId)
      ? automationRequest
      : undefined;
  const currentSettingsScope = useRef(settingsScope);
  currentSettingsScope.current = settingsScope;
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
            referenceSelections:
              visibleSubmission.user.content.referenceSelections,
            createdAt: visibleSubmission.user.createdAt,
          },
        ]
      : []),
  ];
  const carriedEmployeeDraft = useRef<{
    scope: string;
    generation: number;
  } | null>(null);
  useEffect(() => {
    const carried = carriedEmployeeDraft.current;
    carriedEmployeeDraft.current = null;
    if (
      carried?.scope === settingsScope &&
      carried.generation === captureSelection().generation
    )
      return;
    setSessionReferences([]);
    setReferenceSelections([]);
    setReferencePickerOpen(false);
    setReferenceLibraryOpen(false);
    setReferenceToView(null);
    setCompanyReferences([]);
  }, [settingsScope, activeId, captureSelection]);
  const preferences = usePersonalPreferences(workspace, tenantHeaders);
  useEffect(() => {
    setSettings(null);
    if (!workspace?.workspaceId) return;
    const url = new URL(window.location.href);
    const section = normalizeSettingsSection(url.searchParams.get('settings'));
    if (!section) return;
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
      settings?.scope === settingsScope &&
      (settings.section === 'work' || settings.section === 'computer'),
  });
  const [sessionActions] = useState(() =>
    createSessionActions(captureSelection),
  );
  const selectSession = useCallback(
    (sessionId: string | null) => {
      setAutomationNavigation(null);
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
  const workbenchRequested =
    (workbenchEnabled || !!currentAutomationRequest) && layout.open;
  const openAutomationTask = (
    task: { id: string; name?: string },
    sourceSessionId?: string,
  ) => {
    setAutomationRequest((previous) => ({
      scope: settingsScope,
      id: task.id,
      title: task.name ?? '自动化任务',
      revision: (previous?.revision ?? 0) + 1,
      sourceSessionId,
    }));
    layout.show();
  };
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
  const { show: showWorkbench, close: closeWorkbench } = workbench;
  const browseWorkbench = useCallback(
    () => showWorkbench(undefined, true),
    [showWorkbench],
  );
  const dismissWorkbench = useCallback(() => {
    closeWorkbench();
    workbenchEntry.current?.focus();
  }, [closeWorkbench]);
  const [filesRequest, setFilesRequest] = useState({ scope: '', revision: 0 });
  const fileScope = `${workspace?.viewerId}/${workspace?.workspaceId}/${activeId ?? 'draft'}`;
  const currentFilesRequest =
    filesRequest.scope === fileScope ? filesRequest.revision : 0;
  const [moduleRequest, setModuleRequest] = useState<{
    scope: string;
    kind: WorkbenchModule | 'guide' | 'reference';
    revision: number;
    id?: string;
    title?: string;
    category?: 'all' | 'reference' | 'artifact';
  } | null>(null);
  const [workbenchCapabilities, setWorkbenchCapabilities] = useState<{
    scope: string;
    workflow: boolean;
  } | null>(null);
  const currentModuleRequest =
    moduleRequest?.scope === fileScope ? moduleRequest : undefined;
  const [activeModule, setActiveModule] = useState<{
    scope: string;
    kind: WorkbenchModule | 'schedule' | null;
  } | null>(null);
  const sessionAutomations = useSessionAutomations({
    enabled: workbenchEnabled && !!workspace,
    workspaceId: workspace?.workspaceId ?? '',
    scope: settingsScope,
    headers: tenantHeaders,
    refreshKey: `${history?.messages.length}/${history?.messages.at(-1)?.status}`,
  });
  const currentSessionTasks = sessionAutomations.filter(
    (task) => task.sessionId === activeId,
  );
  const scheduledSessions = useMemo(
    () =>
      new Set(
        sessionAutomations.flatMap((task) =>
          task.sessionId ? [task.sessionId] : [],
        ),
      ),
    [sessionAutomations],
  );
  const openSessionTasks = () => {
    if (!activeId || !currentSessionTasks.length) return;
    if (currentSessionTasks.length === 1)
      openAutomationTask(currentSessionTasks[0]!, activeId);
    else {
      setAutomationRequest((previous) => ({
        scope: settingsScope,
        id: activeId,
        title: '当前对话的自动化任务',
        kind: 'sessionSchedules',
        sourceSessionId: activeId,
        revision: (previous?.revision ?? 0) + 1,
      }));
      layout.show();
    }
  };
  const requestWorkbenchModule = (
    kind: WorkbenchModule | 'guide' | 'reference',
    options?: {
      id?: string;
      title?: string;
      category?: 'all' | 'reference' | 'artifact';
    },
  ) => {
    setModuleRequest((previous) => ({
      scope: fileScope,
      kind,
      revision: (previous?.revision ?? 0) + 1,
      ...options,
    }));
    workbench.show(undefined, true);
  };
  const openReference = useCallback(
    (reference: ReferenceDraft) => {
      if (layout.compact || !workbenchEnabled) {
        setRecommendedTemplates(false);
        setReferenceToView(reference);
        setReferenceLibraryOpen(true);
      } else {
        setModuleRequest((previous) => ({
          scope: fileScope,
          kind: 'reference',
          id: reference.revisionId,
          title: `${reference.fileName} · v${reference.revision}`,
          revision: (previous?.revision ?? 0) + 1,
        }));
        showWorkbench(undefined, true);
      }
    },
    [layout.compact, workbenchEnabled, fileScope, showWorkbench],
  );
  const hasWorkbenchContent =
    (!layout.compact && !!currentModuleRequest) ||
    !!currentAutomationRequest ||
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
  const artifactRevision =
    history?.session.id === activeId
      ? history.messages
          .filter((message) => message.role === 'assistant')
          .map((message) => `${message.id}:${message.status}`)
          .join('|') || 'empty'
      : '';
  useEffect(() => {
    const revision = artifactRevision;
    const previous = artifactHistoryRevision.current;
    artifactHistoryRevision.current = { scope: workbench.scope, revision };
    // Any assistant can finish while later steering messages are at the tail.
    // The workbench already reads the initial selection; clicks can reconcile a late file.
    if (
      workbenchEnabled &&
      previous.scope === workbench.scope &&
      previous.revision &&
      revision &&
      previous.revision !== revision
    )
      void workbench.reload();
  }, [workbenchEnabled, artifactRevision, workbench.reload, workbench.scope]);

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
  }, [activeId, transcriptMessages.length, publishTranscriptBottom]);

  // The first local send mounts the transcript before server history changes.
  // Follow and observe those visible rows as soon as they replace the hero.
  useLayoutEffect(() => {
    if (followTranscript.current) scrollToTranscriptBottom();
  }, [transcriptMessages, runViews, scrollToTranscriptBottom]);

  useLayoutEffect(() => {
    resizeComposerTextarea(composerInput.current);
  }, [activeId, transcriptMessages.length, sidebarCollapsed, workspace]);

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
  }, [activeId, transcriptMessages.length, workspace]);

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
  }, [activeId, transcriptMessages.length, scrollToTranscriptBottom]);

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
    setVersionHistoryFile,
    uploadAttachments,
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
    createSession: () => createSession(draftStore.getSnapshot()),
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
  const reloadInteractions = interactions.reload;
  const inputStatus = useMemo(
    () =>
      new Map(
        (interactions.data?.inputs ?? []).map((i) => [i.messageId, i.status]),
      ),
    [interactions.data?.inputs],
  );
  const continueFromWorkbench = useCallback(
    (runId: string) => {
      if (!activeId) return;
      void loadHistory(activeId);
      void streamRun(runId, activeId);
      void reloadInteractions();
    },
    [activeId, loadHistory, streamRun, reloadInteractions],
  );
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
    const text = draftStore.getSnapshot().trim();
    if (!workspace || !text || busy || sessionArchived) return;
    const action = sessionActions.begin('composer');
    if (!action) return;
    const draftAttachments = [...pendingAttachments];
    const draftReferences = [...sessionReferences];
    const draftReferenceSelections = [...referenceSelections];
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
    setReferenceSelections([]);
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
      const inputBody = {
        text,
        ...(draftCompanyReferences.length
          ? { companyTemplates: draftCompanyReferences.map((r) => r.selection) }
          : {}),
        ...(draftReferenceSelections.length
          ? {
              referenceRevisionIds: draftReferenceSelections.map(
                (r) => r.revisionId,
              ),
            }
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
      };
      const retry = await inputRetry(
        `${workspace.organizationId}/${sessionId}`,
        inputBody,
      );
      if (!action.current()) return;
      clientMessageId = retry.id;
      setSubmission({ ...echo, sessionId, preparing: false });
      const result = await readJson<unknown>(
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
      // Keep the retry key unless the receipt is usable; resending after an
      // unreadable answer must not create a second task.
      if (!isSendReceipt(result)) throw new Error('结果待确认，请刷新页面查看');
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
      setReferenceSelections([]);
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
              referenceSelections:
                result.userMessage.content.referenceSelections,
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
      setReferenceSelections(draftReferenceSelections);
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
      (draftStore.getSnapshot().trim() ||
        pendingAttachments.length ||
        sessionReferences.length ||
        companyReferences.length ||
        referenceSelections.length)
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
        setReferenceSelections(item.referenceSelections ?? []);
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
        draftStore.getSnapshot().trim() ||
        pendingAttachments.length ||
        sessionReferences.length ||
        companyReferences.length ||
        referenceSelections.length
      ) ||
      window.confirm('当前有尚未发送的消息或附件，切换工作会清空它们。继续吗？')
    );
  }
  function openBrandContentSession(sessionId: string) {
    if (!workspace || !confirmSessionNavigation()) return;
    if (sessionId !== activeId) {
      clearPendingAttachments();
      setSessionReferences([]);
      setReferenceSelections([]);
      setCompanyReferences([]);
      setReferencePickerOpen(false);
      setDraft('');
    }
    if (layout.compact) setSidebarCollapsed(true);
    // Select the server-created Session before refreshing. Otherwise a fresh
    // draft's workspace refresh may automatically select a different recent task.
    selectSession(sessionId);
    const action = sessionActions.begin('brand-content-navigation');
    if (!action) return;
    const scope = settingsScope;
    void (async () => {
      try {
        await loadWorkspace();
        await nextPaint();
        if (!action.current() || currentSettingsScope.current !== scope) return;
        // A revision may reuse the selected Session. Read its new Run even when
        // selectSession correctly leaves the same selection untouched.
        await loadHistory(sessionId);
      } catch (cause) {
        if (action.current() && currentSettingsScope.current === scope)
          setError(
            cause instanceof Error
              ? cause.message
              : '内容工作会话读取失败，请刷新后重试。',
          );
      } finally {
        action.finish();
      }
    })();
  }
  function startEmployeeSession(
    assignmentId: string,
    created?: EmployeeInstance,
  ) {
    if (
      !workspace ||
      !(created
        ? created.id === assignmentId &&
          created.ownerId === workspace.viewerId &&
          created.organizationId === workspace.organizationId &&
          created.workspaceId === workspace.workspaceId &&
          workspace.employees.some((e) => e.id === created.assignmentId)
        : employeeChoices(workspace).some(
            (employee) => employeeChoiceId(employee) === assignmentId,
          ))
    ) {
      setError('这位员工已不在当前工作区，请重新选择。');
      return;
    }
    if (created) registerEmployeeInstance(created);
    if (layout.compact) setSidebarCollapsed(true);
    resetRunState();
    selectSession(null);
    setHistory(null);
    setPendingEmployeeAssignmentId(assignmentId);
    setDraft('');
    setSessionReferences([]);
    setReferenceSelections([]);
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
  const activeEmployeeProfile = employeeChoiceProfile(
    workspace,
    activeEmployee ? employeeChoiceId(activeEmployee) : undefined,
  );
  const activeEmployeeName =
    (activeEmployee?.instanceId
      ? (activeEmployeeProfile?.name ??
        activeEmployee.currentVersion.manifest.name)
      : undefined) ??
    activeEmployee?.versions.find(
      (version) => version.id === activeSession?.employeeVersionId,
    )?.manifest.name ??
    activeEmployee?.currentVersion.manifest.name ??
    activeEmployeeProfile?.name ??
    activeSession?.employeeName ??
    'AI 员工';
  const activeEmployeeColor =
    activeEmployee?.currentVersion.manifest.appearance?.accentColor ??
    activeEmployeeProfile?.appearance?.accentColor;
  const activeRunMessages = (history?.messages ?? []).filter(
    (message) =>
      message.runId && isMessageRunActive(message, runViews[message.runId]),
  );
  const isRunning = activeRunMessages.length > 0;
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
  function prepareDraft(prepared: PreparedComposerDraft, atStart = false) {
    if (busy || composing.current) return;
    const selection = captureSelection();
    const insert = (current: string) =>
      atStart && current.length
        ? appendComposerDraft(prepared.text, prepareComposerText(current))
        : appendComposerDraft(current, prepared);
    let insertion = insert(draftStore.getSnapshot());
    setDraft((current) => {
      insertion = insert(current);
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

  function prepareEmployeeDraft(text: string, instanceId: string) {
    if (!workspace) throw Error('工作区已变化，请重新打开员工详情。');
    if (busy || composing.current)
      throw Error('请先完成当前输入或等待工作结束，再调整员工内容。');
    const employee = employeeChoices(workspace).find(
      (entry) => entry.instanceId === instanceId,
    );
    if (!employee || employeeChoiceId(employee) !== detailsAssignmentId)
      throw Error('这位员工已不在当前工作区，请重新打开详情。');
    if (activeEmployee?.instanceId !== instanceId || sessionArchived) {
      // Open a draft for the exact employee without discarding the caller's
      // unsent text, attachments or authorized reference selections.
      const wasSession = captureSelection().sessionId !== null;
      resetRunState();
      selectSession(null);
      setHistory(null);
      setPendingEmployeeAssignmentId(employeeChoiceId(employee));
      if (wasSession)
        carriedEmployeeDraft.current = {
          scope: settingsScope,
          generation: captureSelection().generation,
        };
    }
    if (layout.compact) setSidebarCollapsed(true);
    // Method writes require an explicit leading request. Keep any previous
    // draft intact after that request instead of weakening the server gate.
    prepareDraft(prepareComposerText(text), true);
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
        revisionId: reference.selection.revisionId,
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
    setReferenceLibraryOpen(false);
  }

  const openBridgeSettings = () => {
    setSettings({ scope: settingsScope, section: 'computer' });
    return loadBridgeDevices(true);
  };

  const useWorkbenchReference = (reference: ReferenceRevision) => {
    if (
      referenceSelections.length >= 3 &&
      !referenceSelections.some(
        (item) => item.revisionId === reference.revisionId,
      )
    ) {
      setError('每次任务最多引用 3 份资料。');
      return;
    }
    setReferenceSelections((current) =>
      current.some((item) => item.revisionId === reference.revisionId)
        ? current
        : [...current, reference],
    );
    requestAnimationFrame(() => composerInput.current?.focus());
  };
  const viewWorkbenchTemplate = (reference: ReferenceRevision) => {
    setRecommendedTemplates(false);
    setReferenceToView(reference);
    setReferenceLibraryOpen(true);
  };
  const renderComposer = (hero = false) => (
    <DraftChatComposer
      taskSuggestions={
        taskSuggestionsEnabled
          ? (suggestionVersion?.taskSuggestions ?? [])
          : undefined
      }
      taskScope={taskScope}
      taskNextSteps={nextSteps.data}
      onOpenTasks={() => {
        void nextSteps.reload();
      }}
      onOpenCompanyTemplates={() => {
        setRecommendedTemplates(true);
        setReferenceToView(null);
        setReferenceLibraryOpen(true);
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
      referenceSelections={referenceSelections}
      onRemoveReference={(id) =>
        setReferenceSelections((items) =>
          items.filter((r) => r.revisionId !== id),
        )
      }
      onOpenReferenceLibrary={() => {
        if (!layout.compact && workbenchEnabled) {
          requestWorkbenchModule('files', { category: 'reference' });
          return;
        }
        setRecommendedTemplates(false);
        setReferenceToView(null);
        setReferenceLibraryOpen(true);
      }}
      onRemoveSessionReference={(id) =>
        setSessionReferences((current) =>
          current.filter((item) => item.sessionId !== id),
        )
      }
      employeeName={activeEmployeeName}
      attachmentMenuOpen={attachmentMenuOpen}
      busy={busy}
      composerInput={composerInput}
      composing={composing}
      draftStore={draftStore}
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
      contextCompacting={contextCompacting}
      onAttachmentMenuOpenChange={setAttachmentMenuOpen}
      onCancelRun={cancelRun}
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
      onCancelBridgeUpload={cancelBridgeUpload}
      bridgeUploadStatus={bridgeUploadStatus}
      pendingAttachments={
        visibleSubmission
          ? pendingAttachments.filter(
              (file) => !file.mediaType.startsWith('image/'),
            )
          : pendingAttachments
      }
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
          key={settingsScope}
          workspace={workspace}
          onClose={() => setEmployeePickerOpen(false)}
          onSelect={startEmployeeSession}
          onCreated={(instance) => startEmployeeSession(instance.id, instance)}
          headers={tenantHeaders}
        />
      )}
      {archive.overlays}
      {referenceLibraryOpen && workspace && (
        <ReferenceLibrary
          hideUpload={!layout.compact}
          key={`references/${settingsScope}/${referenceToView?.revisionId ?? 'choose'}`}
          workspaceId={workspace.workspaceId}
          headers={tenantHeaders}
          onClose={() => setReferenceLibraryOpen(false)}
          initialReference={referenceToView}
          onPrepareTemplate={prepareCompanyTemplate}
          initialTemplates={
            recommendedTemplates
              ? {
                  employeeId: activeEmployee?.employeeId,
                  taskText: draftStore.getSnapshot().slice(0, 512),
                }
              : undefined
          }
          onSelect={(r) => {
            if (
              referenceSelections.length >= 3 &&
              !referenceSelections.some((s) => s.revisionId === r.revisionId)
            ) {
              setError('每次任务最多引用 3 份资料。');
            } else {
              setReferenceSelections((items) =>
                items.some((s) => s.revisionId === r.revisionId)
                  ? items
                  : [...items, r],
              );
              setError('');
            }
            setReferenceLibraryOpen(false);
          }}
        />
      )}
      <ChatSidebar
        scheduledSessions={scheduledSessions}
        experienceEnabled={experienceEnabled}
        automationsActive={automationsOpen}
        onOpenAutomations={() => {
          setAutomationNavigation({ scope: settingsScope, view: 'catalog' });
          setSettings(null);
          if (layout.compact) setSidebarCollapsed(true);
        }}
        archive={archive}
        capabilities={(section) => (
          <CapabilityContent
            key={`capabilities/${section}/${workspace.viewerId}/${workspace.workspaceId}/${activeId}`}
            scope={section}
            computerChips={bridgeChips(bridgeDevices)}
            data={readiness.data}
            loading={readiness.loading}
            error={readiness.error}
            busy={busy}
            onRefresh={() => void readiness.reload()}
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
        )}
        settingsSection={
          bridgeOpen
            ? 'computer'
            : settings?.scope === settingsScope
              ? settings.section
              : null
        }
        onSettingsSectionChange={(section) => {
          setBridgeOpen(false);
          const nextSection = normalizeSettingsSection(section);
          if (
            bridgeOpen ||
            nextSection === 'work' ||
            nextSection === 'computer'
          )
            void readiness.reload();
          setSettings(
            nextSection === null
              ? null
              : { scope: settingsScope, section: nextSection },
          );
        }}
        onCapabilitiesChange={() => void readiness.reload()}
        onBridge={() => void openBridgeSettings()}
        bridge={bridge}
        bridgeReleases={bridgeReleases}
        monthlyQuota={monthlyQuota}
        preferences={preferences}
        activeId={activeId}
        collapsed={sidebarCollapsed}
        overlay={layout.compact && !sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        onNewSession={(assignmentId) => {
          if (!confirmSessionNavigation()) return;
          setAutomationNavigation(null);
          if (assignmentId) startEmployeeSession(assignmentId);
          else if (employeeChoices(workspace).length > 0)
            setEmployeePickerOpen(true);
          else setError('当前没有可用员工，请先派驻员工。');
        }}
        onOpenEmployeeDetails={(assignmentId) => {
          setDetailsAssignmentId(
            assignmentId ??
              (activeEmployee ? employeeChoiceId(activeEmployee) : null),
          );
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
            setReferenceSelections([]);
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
        {automationsOpen ? (
          <AutomationTaskList
            key={`automations/${settingsScope}`}
            workspaceId={workspace.workspaceId}
            scope={settingsScope}
            headers={tenantHeaders}
            employees={employeeChoices(workspace).map((employee) => ({
              id: employeeChoiceId(employee),
              name: employee.currentVersion.manifest.name,
            }))}
            selectedId={currentAutomationRequest?.id}
            onSelect={openAutomationTask}
            onNew={() => {
              if (!confirmSessionNavigation()) return;
              if (activeEmployee)
                startEmployeeSession(employeeChoiceId(activeEmployee));
              else setEmployeePickerOpen(true);
              setAutomationNavigation({ scope: settingsScope, view: 'create' });
            }}
          />
        ) : (
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
                      <h1>{activeSession?.title ?? '新的工作'}</h1>
                    </div>
                  </div>
                  <div
                    className={`${conversationUi.headerActions} ${styles.conversationActions}`}
                  >
                    {activeId && (
                      <NativeSubagentDirectory
                        key={`${settingsScope}/${activeId}`}
                        workspaceId={workspace.workspaceId}
                        sessionId={activeId}
                        headers={tenantHeaders}
                        refreshKey={`${isRunning}/${history?.messages.at(-1)?.status}`}
                      />
                    )}
                    {!layout.compact && workbenchEnabled ? (
                      <UnifiedWorkbenchControls
                        scope={`${settingsScope}/${activeEmployee?.instanceId ?? 'none'}`}
                        scopeId={settingsScope}
                        workspaceId={workspace.workspaceId}
                        viewerId={workspace.viewerId}
                        instanceId={activeEmployee?.instanceId}
                        kind={
                          activeEmployee?.instances?.find(
                            (instance) =>
                              instance.id === activeEmployee.instanceId,
                          )?.kind
                        }
                        headers={tenantHeaders}
                        refreshKey={`${activeId}/${history?.messages.length}/${history?.messages.at(-1)?.status}`}
                        open={workbenchOpen}
                        selected={
                          activeModule?.scope === fileScope
                            ? activeModule.kind === 'schedule' &&
                              currentAutomationRequest?.sourceSessionId !==
                                activeId
                              ? null
                              : activeModule.kind
                            : null
                        }
                        schedule={
                          !sessionArchived && currentSessionTasks.length > 0
                        }
                        onSchedule={openSessionTasks}
                        onOpen={(kind) => requestWorkbenchModule(kind)}
                        onToggle={() => {
                          if (workbenchOpen) dismissWorkbench();
                          else if (!hasWorkbenchContent)
                            requestWorkbenchModule('guide');
                          else layout.show();
                        }}
                        entryRef={workbenchEntry}
                        onCapabilities={setWorkbenchCapabilities}
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          className={workbenchUi.entry}
                          onClick={() => {
                            setRecommendedTemplates(false);
                            setReferenceToView(null);
                            setReferenceLibraryOpen(true);
                          }}
                        >
                          参考资料
                        </button>
                        <BrandContentWorkspaceEntry
                          key={`${settingsScope}/${workspace.viewerId}/${activeEmployee?.instanceId ?? 'none'}`}
                          scopeId={settingsScope}
                          workspaceId={workspace.workspaceId}
                          viewerId={workspace.viewerId}
                          instanceId={activeEmployee?.instanceId}
                          kind={
                            activeEmployee?.instances?.find(
                              (instance) =>
                                instance.id === activeEmployee.instanceId,
                            )?.kind
                          }
                          employeeName={activeEmployeeName}
                          headers={tenantHeaders}
                          onOpenSession={openBrandContentSession}
                        />
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
                            {workbench.noticeId && !workbenchOpen
                              ? ' · 新成果'
                              : ''}
                          </button>
                        ) : null}
                      </>
                    )}
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
                    {automationCreate && (
                      <p>
                        说明什么时候、由谁做什么，例如“每 2
                        分钟提醒我喝水”或“每天北京时间 09:00，整理当天工作”。
                      </p>
                    )}
                    <div className={styles.heroHeadline}>
                      <span className={styles.heroMark} aria-hidden="true">
                        {Array.from(activeEmployeeName)[0]}
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
                      onRetry={() => void reloadInteractions()}
                      sessionId={activeId}
                      onArtifact={(id) => {
                        workbench.show(id);
                      }}
                      onOperation={(id) => {
                        const card = document.getElementById(`operation-${id}`);
                        if (!card) {
                          setError(
                            '这张卡片还没加载出来，请稍后再点一次「查看并确认」。',
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
                  {!workbenchEnabled && interactions.error ? (
                    <p role="status">{interactions.error}</p>
                  ) : null}
                  <MessageFeedbackProvider
                    readOnly={sessionArchived}
                    key={`feedback/${workspace.organizationId}/${workspace.workspaceId}/${workspace.viewerId}/${activeId}`}
                    sessionId={activeId!}
                    workspaceId={workspace.workspaceId}
                    headers={tenantHeaders}
                  >
                    <InputStatusContext.Provider value={inputStatus}>
                      <ChatTranscript
                        onOpenReference={openReference}
                        onOpenAutomation={(id) => openAutomationTask({ id })}
                        streamingOutput={preferences.value.streamingOutput}
                        fontSize={preferences.value.fontSize}
                        transcriptView={preferences.value.transcriptView}
                        collapseTiming={preferences.value.collapseTiming}
                        employeeName={activeEmployeeName}
                        atBottom={atTranscriptBottom}
                        localCommandsEnabled={localCommandsEnabled}
                        localMcpEnabled={localMcpEnabled}
                        onResolveArtifactLink={workbench.resolveDownloadLink}
                        runTimings={interactions.data?.runTimings}
                        messages={transcriptMessages}
                        messageImages={messageImages}
                        onLoadRunTrace={loadRunTrace}
                        onRecoverRun={recoverRun}
                        onScrollToBottom={scrollToTranscriptBottom}
                        recoverableRunView={recoverableRunView}
                        historyStale={historyStale}
                        onRefreshHistory={refreshHistory}
                        runTraces={runTraces}
                        runViews={runViews}
                        tenantHeaders={tenantHeaders}
                        transcriptColumn={transcriptColumn}
                        workspaceId={workspace.workspaceId}
                        artifacts={workbench.artifacts}
                        onOpenArtifact={showWorkbench}
                      />
                    </InputStatusContext.Provider>
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
                      !hasDraft &&
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
        )}
      </section>

      {(workbenchEnabled || currentAutomationRequest) && hasWorkbenchContent ? (
        <ArtifactWorkbench
          desktop={!layout.compact}
          moduleRequest={currentModuleRequest}
          experienceAvailable={!!activeEmployee?.instanceId}
          workflowAvailable={
            workbenchCapabilities?.scope ===
              `${settingsScope}/${activeEmployee?.instanceId ?? 'none'}` &&
            workbenchCapabilities.workflow
          }
          onModuleViewed={(kind) =>
            announceWorkbenchRead(
              `${settingsScope}/${activeEmployee?.instanceId ?? 'none'}`,
              kind,
            )
          }
          onActiveModule={(kind) =>
            setActiveModule((previous) =>
              previous?.scope === fileScope && previous.kind === kind
                ? previous
                : { scope: fileScope, kind },
            )
          }
          renderModule={(kind, active, onOpenFile) => (
            <Suspense fallback={<p role="status">正在打开工作台…</p>}>
              {kind === 'files' ? (
                <WorkbenchFilesPanel
                  workspaceId={workspace.workspaceId}
                  sessionId={activeId}
                  headers={tenantHeaders}
                  active={active}
                  initialCategory={
                    currentModuleRequest?.kind === 'files'
                      ? currentModuleRequest.category
                      : undefined
                  }
                  readOnly={sessionArchived}
                  onRead={() =>
                    announceWorkbenchRead(
                      `${settingsScope}/${activeEmployee?.instanceId ?? 'none'}`,
                      'files',
                    )
                  }
                  onOpen={(file) => {
                    const artifact = workbench.artifacts.find(
                      (item) => item.object.id === file.objectId,
                    );
                    if (artifact) showWorkbench(artifact.id);
                    else onOpenFile(file.objectId, file.fileName);
                  }}
                  onTemplate={viewWorkbenchTemplate}
                  onUse={useWorkbenchReference}
                />
              ) : kind === 'experience' ? (
                <WorkbenchExperiencePanel
                  scopeId={settingsScope}
                  workspaceId={workspace.workspaceId}
                  instanceId={activeEmployee?.instanceId}
                  employees={employeeChoices(workspace).flatMap((employee) =>
                    employee.instanceId
                      ? [
                          {
                            id: employee.instanceId,
                            name:
                              employeeChoiceProfile(
                                workspace,
                                employeeChoiceId(employee),
                              )?.name ?? employee.currentVersion.manifest.name,
                          },
                        ]
                      : [],
                  )}
                  headers={tenantHeaders}
                  active={active}
                  automatic={experienceEnabled}
                  onCorrect={(instanceId, text) => {
                    if (
                      sessionArchived ||
                      activeEmployee?.instanceId !== instanceId
                    ) {
                      if (!confirmSessionNavigation()) return;
                      startEmployeeSession(instanceId);
                      setDraft(text);
                    } else
                      setDraft(
                        [draftStore.getSnapshot(), text]
                          .filter(Boolean)
                          .join('\n'),
                      );
                    layout.close();
                    requestAnimationFrame(() => composerInput.current?.focus());
                  }}
                />
              ) : activeEmployee?.instanceId &&
                workbenchCapabilities?.scope ===
                  `${settingsScope}/${activeEmployee.instanceId}` &&
                workbenchCapabilities.workflow ? (
                <BrandContentPanel
                  key={`${settingsScope}/${activeEmployee.instanceId}`}
                  embedded
                  active={active}
                  scopeId={settingsScope}
                  workspaceId={workspace.workspaceId}
                  instanceId={activeEmployee.instanceId}
                  employeeName={activeEmployeeName}
                  headers={tenantHeaders}
                  onClose={dismissWorkbench}
                  onOpenSession={openBrandContentSession}
                />
              ) : (
                <p role="status">这位员工当前没有可用的工作流。</p>
              )}
            </Suspense>
          )}
          onOpenReference={openReference}
          onUseFileReference={useWorkbenchReference}
          onTemplateFile={viewWorkbenchTemplate}
          taskRequest={currentAutomationRequest}
          renderSessionTasks={(sessionId, active) =>
            active ? (
              <AutomationTaskList
                workspaceId={workspace.workspaceId}
                scope={settingsScope}
                headers={tenantHeaders}
                sessionId={sessionId}
                employees={[]}
                onSelect={(task) => openAutomationTask(task, sessionId)}
                onNew={() => {}}
              />
            ) : null
          }
          renderTask={(taskId, active) => (
            <AutomationTaskDetail
              taskId={taskId}
              active={active}
              workspaceId={workspace.workspaceId}
              scope={settingsScope}
              headers={tenantHeaders}
              onOpenSession={openBrandContentSession}
            />
          )}
          readOnly={sessionArchived}
          open={workbenchOpen}
          width={resize.width}
          selectionRequest={workbench.selectionRequest}
          onBrowseFiles={browseWorkbench}
          key={`artifacts/${workspace.viewerId ?? ''}/${workspace.workspaceId}/${activeId}`}
          filesRequest={currentFilesRequest}
          dockScope={`${workspace.organizationId}/${workspace.workspaceId}/${workspace.viewerId ?? 'anonymous'}/${activeId ?? 'draft'}`}
          sessionId={activeId}
          workspaceId={workspace.workspaceId}
          terminalIdentity={
            workspace.viewerId
              ? {
                  organizationId: workspace.organizationId,
                  ownerId: workspace.viewerId,
                }
              : undefined
          }
          onOpenComputerSettings={openBridgeSettings}
          tenantHeaders={tenantHeaders}
          artifacts={workbench.artifacts}
          selectedId={workbench.selectedId}
          nextCursor={workbench.nextCursor}
          listError={workbench.error}
          listLoading={workbench.loading}
          noticeId={workbench.noticeId}
          narrow={workbenchNarrow}
          onSelect={showWorkbench}
          onClose={dismissWorkbench}
          onReload={workbench.reload}
          onContinued={continueFromWorkbench}
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
      {workbenchEnabled && workspace.viewerId && (
        <TerminalCleanupStatus
          owner={{
            organizationId: workspace.organizationId,
            workspaceId: workspace.workspaceId,
            ownerId: workspace.viewerId,
          }}
        />
      )}

      <EmployeeDetailsDialog
        onClose={() => setEmployeeDetailsOpen(false)}
        open={employeeDetailsOpen}
        scopeId={settingsScope}
        instanceId={
          detailsAssignmentId
            ? employeeChoice(workspace, detailsAssignmentId)?.instanceId
            : undefined
        }
        employeeId={
          detailsAssignmentId
            ? employeeChoice(workspace, detailsAssignmentId)?.employeeId
            : undefined
        }
        workspaceId={workspace.workspaceId}
        headers={tenantHeaders}
        onPrepare={prepareEmployeeDraft}
        onProfileUpdated={registerEmployeeInstance}
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

function BrandContentWorkspaceEntry({
  employeeName,
  onOpenSession,
  ...scope
}: {
  scopeId: string;
  workspaceId: string;
  viewerId?: string | null;
  instanceId?: string;
  kind?: 'general' | 'custom';
  employeeName: string;
  headers: Record<string, string>;
  onOpenSession: (sessionId: string) => void;
}) {
  const catalog = useBrandContentWorkspace(scope);
  const [openedScope, setOpenedScope] = useState<string | null>(null);
  if (!catalog.available || !scope.instanceId) return null;
  const open = openedScope === catalog.scope;
  return (
    <>
      <button
        type="button"
        className={workbenchUi.entry}
        aria-expanded={open}
        onClick={() => setOpenedScope(catalog.scope)}
      >
        内容工作台
      </button>
      {open && (
        <Suspense fallback={<span role="status">正在打开内容工作台…</span>}>
          <BrandContentPanel
            key={catalog.scope}
            scopeId={scope.scopeId}
            workspaceId={scope.workspaceId}
            instanceId={scope.instanceId}
            employeeName={employeeName}
            headers={scope.headers}
            onClose={() => setOpenedScope(null)}
            onOpenSession={(sessionId) => {
              setOpenedScope(null);
              onOpenSession(sessionId);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
