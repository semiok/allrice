'use client';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { useNativeSubagents } from './use-native-subagents';
import { createSessionRunStream } from './session-run-stream';
import { EmployeeSidebarView } from './employee-sidebar-view';

type Props = ComponentProps<typeof EmployeeSidebarView> & {
  nativeReadyKey?: string;
  pendingNativeSessions?: ReadonlySet<string>;
};

/** The 3.x entry keeps its existing background readers outside the shared View. */
export function EmployeeSidebar(props: Props) {
  const {
    workspace,
    sessions,
    activeId,
    archive,
    pendingNativeSessions,
    nativeReadyKey = '',
    nativeReads,
  } = props;
  const [visible, setVisible] = useState<string[]>([]);
  const activityScope = `${workspace.organizationId}/${workspace.workspaceId}/${workspace.viewerId}`;
  const activityCallbacks = useRef({
    scope: activityScope,
    reload: archive?.reload,
  });
  activityCallbacks.current = { scope: activityScope, reload: archive?.reload };
  const activityObservers = useRef(
    new Map<
      string,
      {
        key: string;
        scope: string;
        runIds: string[];
        stream: ReturnType<typeof createSessionRunStream>;
      }
    >(),
  );
  const activityRequests = JSON.stringify(
    archive
      ? sessions
          .filter(
            (session) =>
              visible.includes(session.id) &&
              session.id !== activeId &&
              !pendingNativeSessions?.has(session.id) &&
              session.ownerId === workspace.viewerId &&
              session.activeRunIds?.length,
          )
          .map((session) => [
            session.id,
            [...new Set(session.activeRunIds)].sort(),
          ])
      : [],
  );
  useEffect(() => {
    const requests = new Map(
      JSON.parse(activityRequests) as [string, string[]][],
    );
    for (const [id, entry] of activityObservers.current) {
      if (entry.key !== JSON.stringify([activityScope, requests.get(id)])) {
        entry.stream.deactivate();
        activityObservers.current.delete(id);
      }
    }
    for (const [sessionId, runIds] of requests) {
      if (activityObservers.current.has(sessionId)) continue;
      const stream = createSessionRunStream({
        sessionId,
        workspaceId: workspace.workspaceId,
        tenantHeaders: {
          'x-allrice-organization-id': workspace.organizationId,
          'x-allrice-workspace-id': workspace.workspaceId,
        },
        loadHistory: async () => {},
        loadWorkspace: async () => {
          if (activityCallbacks.current.scope === activityScope)
            void activityCallbacks.current.reload?.();
        },
        setError: () => {},
      });
      activityObservers.current.set(sessionId, {
        key: JSON.stringify([activityScope, runIds]),
        scope: activityScope,
        runIds,
        stream,
      });
      stream.activate();
      for (const runId of runIds) void stream.streamRun(runId);
    }
  }, [
    activityRequests,
    activityScope,
    workspace.workspaceId,
    workspace.organizationId,
  ]);
  useEffect(
    () => () => {
      for (const { stream } of activityObservers.current.values())
        stream.deactivate();
      activityObservers.current.clear();
    },
    [activityScope],
  );
  useEffect(() => {
    const reconnect = async () => {
      const callbacks = activityCallbacks.current;
      if (callbacks.scope !== activityScope) return;
      await callbacks.reload?.();
      if (activityCallbacks.current.scope !== activityScope) return;
      for (const {
        scope,
        stream,
        runIds,
      } of activityObservers.current.values()) {
        if (scope !== activityScope) continue;
        const { runViews } = stream.getSnapshot();
        for (const runId of runIds)
          if (runViews[runId]?.connectionError) void stream.streamRun(runId);
      }
    };
    const online = () => void reconnect();
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [activityScope]);
  const activeSession = sessions.find((session) => session.id === activeId);
  const { reads: backgroundReads } = useNativeSubagents(
    workspace.workspaceId,
    {
      'x-allrice-organization-id': workspace.organizationId,
      'x-allrice-workspace-id': workspace.workspaceId,
    },
    Object.fromEntries(
      sessions
        .filter(
          (session) =>
            visible.includes(session.id) &&
            session.id !== activeId &&
            !pendingNativeSessions?.has(session.id) &&
            (!session.ownerId || session.ownerId === workspace.viewerId),
        )
        .map((session) => [
          session.id,
          `${session.updatedAt}/${session.running}`,
        ]),
    ),
    true,
  );
  const { reads: activeReads } = useNativeSubagents(
    workspace.workspaceId,
    {
      'x-allrice-organization-id': workspace.organizationId,
      'x-allrice-workspace-id': workspace.workspaceId,
    },
    nativeReads === undefined &&
      activeSession &&
      visible.includes(activeSession.id) &&
      (!activeSession.ownerId || activeSession.ownerId === workspace.viewerId)
      ? {
          [activeSession.id]: `${activeSession.updatedAt}/${activeSession.running}/${nativeReadyKey}`,
        }
      : {},
    true,
  );
  const reads = useMemo(
    () => ({
      ...backgroundReads,
      ...(nativeReads === undefined
        ? activeReads
        : activeId && activeId in nativeReads
          ? { [activeId]: nativeReads[activeId]! }
          : {}),
    }),
    [backgroundReads, activeReads, nativeReads, activeId],
  );
  return (
    <EmployeeSidebarView
      {...props}
      nativeReads={reads}
      onVisibleSessionsChange={setVisible}
    />
  );
}
