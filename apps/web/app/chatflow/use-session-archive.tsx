'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  EmployeeSessionGroup,
  Session,
  Workspace,
} from './chatflow-types';
import type { ArchivedFilter } from './dsh-upstream/workspace/tree';
import type { PropsRenderSlots } from './dsh-upstream/workspace/contracts';
import {
  ArchiveSessionMenuItem,
  ArchiveSessionRowButton,
  SessionArchiveConfirmDialog,
} from './dsh-upstream/archive/ArchiveSession';
import { RowActionToast } from './dsh-upstream/archive/RowActionToast';
import type {
  RowToastState,
  SessionArchiveConfirmRequest,
} from './dsh-upstream/archive/contracts';
import { employeeTranslate } from './employee-navigation';
import { readJson } from './chatflow-utils';

type Page = {
  sessions: Session[];
  nextCursor: string | null;
  employeeGroups?: EmployeeSessionGroup[];
  employees?: Record<
    string,
    { nextCursor: string | null; loading: boolean; error: string }
  >;
};
export function useSessionArchive({
  workspace,
  headers,
  onUpdated,
  selectedSession,
}: {
  selectedSession?: Session;
  workspace: Workspace | null;
  headers: Record<string, string>;
  onUpdated: (session: Session) => void;
}) {
  const scope = `${workspace?.organizationId}/${workspace?.workspaceId}/${workspace?.viewerId}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [filter, setFilter] = useState<ArchivedFilter>('default');
  const [page, setPage] = useState<
    (Page & { scope: string; filter: ArchivedFilter }) | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [request, setRequest] = useState<SessionArchiveConfirmRequest | null>(
    null,
  );
  const [toast, setToast] = useState<RowToastState | null>(null);
  const generation = useRef(0);
  const employeeRequests = useRef(new Map<string, symbol>());
  const pending = useRef(new Map<string, symbol>());
  const toastSeq = useRef(0);
  const workspaceId = workspace?.workspaceId;
  const refreshKey = workspace?.sessions
    .map((s) => `${s.id}/${s.archivedAt}/${s.updatedAt}`)
    .join(',');
  const load = useCallback(
    async (cursor?: string) => {
      if (!workspaceId) return;
      const ticket = ++generation.current;
      employeeRequests.current.clear();
      setPage((old) =>
        old
          ? {
              ...old,
              employees: Object.fromEntries(
                Object.entries(old.employees ?? {}).map(([id, item]) => [
                  id,
                  { ...item, loading: false },
                ]),
              ),
            }
          : old,
      );
      setLoading(true);
      setError('');
      try {
        const query = new URLSearchParams({
          workspaceId,
          archived: filter === 'only' ? 'only' : String(filter === 'show'),
        });
        if (cursor) query.set('cursor', cursor);
        const result = await fetch(`/api/v1/sessions?${query}`, {
          headers,
          cache: 'no-store',
        }).then(readJson<Page>);
        if (ticket !== generation.current || currentScope.current !== scope)
          return;
        if (!Array.isArray(result.sessions))
          throw new Error('工作记录响应无效，请重试');
        setPage((old) => {
          const before =
            cursor && old?.scope === scope && old.filter === filter
              ? old.sessions
              : [];
          return {
            scope,
            filter,
            nextCursor: result.nextCursor,
            employeeGroups: result.employeeGroups,
            sessions: [
              ...new Map(
                [...before, ...result.sessions].map((s) => [s.id, s]),
              ).values(),
            ],
          };
        });
      } catch (cause) {
        if (ticket === generation.current && currentScope.current === scope)
          setError(cause instanceof Error ? cause.message : '工作记录加载失败');
      } finally {
        if (ticket === generation.current) setLoading(false);
      }
    },
    [filter, headers, scope, workspaceId],
  );
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load, refreshKey]);
  useEffect(() => {
    setPage(null);
    setRequest(null);
    setToast(null);
    setError('');
    pending.current.clear();
    setFilter('default');
  }, [scope]);
  useEffect(() => {
    const refresh = () => {
      void load();
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [load]);
  const listed =
    page?.scope === scope && page.filter === filter
      ? page.sessions.map((s) => ({
          ...workspace?.sessions.find((item) => item.id === s.id),
          ...s,
        }))
      : (workspace?.sessions ?? []).filter(
          (s) =>
            filter === 'show' ||
            (filter === 'only' ? !!s.archivedAt : !s.archivedAt),
        );
  // A selected deep link can be older than the first server page. Keep its
  // already-authorized snapshot visible without treating the page as a full index.
  const sessions =
    selectedSession &&
    !listed.some((s) => s.id === selectedSession.id) &&
    (filter === 'show' ||
      (filter === 'only'
        ? !!selectedSession.archivedAt
        : !selectedSession.archivedAt))
      ? [selectedSession, ...listed]
      : listed;
  const currentPage =
    page?.scope === scope && page.filter === filter ? page : null;
  const cursorFor = (employeeId: string) => {
    const employeePage = currentPage?.employees?.[employeeId];
    if (employeePage) return employeePage.nextCursor;
    const total = currentPage?.employeeGroups
      ? (currentPage.employeeGroups.find(
          (g) => g.employeeAssignmentId === employeeId,
        )?.count ?? 0)
      : undefined;
    const loaded =
      currentPage?.sessions.filter((s) => s.employeeAssignmentId === employeeId)
        .length ?? 0;
    return total !== undefined && total <= loaded
      ? null
      : currentPage?.nextCursor;
  };
  async function loadMore(employeeId: string) {
    const cursor = cursorFor(employeeId);
    if (
      !workspaceId ||
      loading ||
      !cursor ||
      employeeRequests.current.has(employeeId)
    )
      return;
    const ticket = generation.current;
    const request = Symbol();
    employeeRequests.current.set(employeeId, request);
    const current = () =>
      ticket === generation.current &&
      currentScope.current === scope &&
      employeeRequests.current.get(employeeId) === request;
    const update = (
      next: { nextCursor: string | null; loading: boolean; error: string },
      added: Session[] = [],
    ) => {
      if (!current()) return;
      setPage((old) =>
        old?.scope === scope && old.filter === filter
          ? {
              ...old,
              sessions: [
                ...new Map(
                  [...old.sessions, ...added].map((s) => [s.id, s]),
                ).values(),
              ],
              employees: { ...old.employees, [employeeId]: next },
            }
          : old,
      );
    };
    update({ nextCursor: cursor, loading: true, error: '' });
    try {
      const query = new URLSearchParams({
        workspaceId,
        employeeAssignmentId: employeeId,
        cursor,
        archived: filter === 'only' ? 'only' : String(filter === 'show'),
      });
      const result = await fetch(`/api/v1/sessions?${query}`, {
        headers,
        cache: 'no-store',
      }).then(readJson<Page>);
      if (
        !Array.isArray(result.sessions) ||
        result.sessions.some((s) => s.employeeAssignmentId !== employeeId)
      )
        throw new Error('工作记录响应无效，请重试');
      update(
        { nextCursor: result.nextCursor, loading: false, error: '' },
        result.sessions,
      );
    } catch (cause) {
      update({
        nextCursor: cursor,
        loading: false,
        error: cause instanceof Error ? cause.message : '工作记录加载失败',
      });
    } finally {
      if (current()) employeeRequests.current.delete(employeeId);
    }
  }
  async function mutate(
    sessionId: string,
    archived: boolean,
    stopActivity = false,
  ) {
    if (!workspaceId || pending.current.has(sessionId)) return;
    const operation = Symbol();
    pending.current.set(sessionId, operation);
    setError('');
    try {
      const response = await fetch(
        `/api/v1/sessions/${sessionId}?workspaceId=${workspaceId}`,
        {
          method: 'PATCH',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            archived,
            ...(stopActivity ? { stopActivity: true } : {}),
          }),
        },
      );
      if (currentScope.current !== scope) return;
      if (response.status === 409) {
        const body = await response.json();
        if (body.error?.code === 'SESSION_ACTIVE') {
          setRequest({
            sessionId,
            displayTitle:
              sessions.find((s) => s.id === sessionId)?.title ?? '当前会话',
            activity: body.error.activity,
          });
          return;
        }
        throw new Error(body.error?.message ?? '归档失败');
      }
      const result = await readJson<{ session: Session }>(response);
      if (currentScope.current !== scope) return;
      generation.current++;
      onUpdated(result.session);
      setPage((old) =>
        old
          ? {
              ...old,
              sessions: old.sessions.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      ...result.session,
                      running: false,
                      pendingInteraction: undefined,
                    }
                  : s,
              ),
            }
          : old,
      );
      pending.current.delete(sessionId);
      if (archived)
        setToast({
          kind: stopActivity ? 'stoppedAndArchived' : 'archived',
          sessionId,
          seq: ++toastSeq.current,
        });
      await load();
    } finally {
      if (
        currentScope.current === scope &&
        pending.current.get(sessionId) === operation
      )
        pending.current.delete(sessionId);
    }
  }
  const act = (id: string, archived: boolean) => {
    void mutate(id, archived).catch((cause) => {
      if (currentScope.current === scope)
        setError(cause instanceof Error ? cause.message : '归档操作失败');
    });
  };
  const archived = new Set(
    sessions.filter((s) => s.archivedAt).map((s) => s.id),
  );
  const renderActions: PropsRenderSlots<
    | 'sidebar.workspaces.session.menu.item'
    | 'sidebar.workspaces.session.row.action'
  >['renderSlot'] = (name, props, context) => {
    const session = sessions.find((s) => s.id === props.sessionId);
    if (session?.ownerId && session.ownerId !== workspace?.viewerId)
      return null;
    const injected = {
      sessionId: props.sessionId,
      useArchived: <R,>(select: (value: ReadonlySet<string>) => R) =>
        select(archived),
      archiveSession: (id: string) => act(id, true),
      unarchiveSession: (id: string) => act(id, false),
      t: employeeTranslate,
    };
    return name === 'sidebar.workspaces.session.row.action' ? (
      <ArchiveSessionRowButton {...injected} />
    ) : context ? (
      <ArchiveSessionMenuItem
        {...injected}
        useMenuOpenState={() => context.hookContext}
      />
    ) : null;
  };
  return {
    sessions,
    filter,
    setFilter,
    loading,
    error,
    reload: () => void load(),
    employeeGroups: currentPage?.employeeGroups,
    employeePages: currentPage?.employees,
    hasMore: (employeeId: string) => !!cursorFor(employeeId),
    loadMore: (employeeId: string) => void loadMore(employeeId),
    restore: (id: string) => act(id, false),
    renderActions,
    overlays: (
      <>
        <SessionArchiveConfirmDialog
          useArchiveRequest={(select) => select(request)}
          settleSessionArchive={() => setRequest(null)}
          stopAndArchiveSession={(id) => mutate(id, true, true)}
          t={employeeTranslate}
        />
        <RowActionToast
          useToast={(select) => select(toast)}
          dismissToast={() => setToast(null)}
          undoArchive={(id) => act(id, false)}
          showArchived={() => setFilter('only')}
          t={employeeTranslate}
        />
      </>
    ),
  };
}
