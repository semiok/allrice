'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from 'react';

import type { SaasCapabilityManifest } from '@allrice/contracts';

import type { History, Session, Workspace } from './chatflow-types';
import { readJson } from './chatflow-utils';
import { createSessionSelection } from './session-selection';
import { rememberSessionLocation } from './session-location';

type UseSessionOptions = {
  setError: (message: string) => void;
};

type CachedHistory = { value: History; prefetched: boolean; loadedAt: number };
function rememberHistory(
  cache: Map<string, CachedHistory>,
  value: History,
  prefetched = false,
) {
  cache.delete(value.session.id);
  cache.set(value.session.id, { value, prefetched, loadedAt: Date.now() });
  while (cache.size > 8) cache.delete(cache.keys().next().value!);
}

export function useSession({ setError }: UseSessionOptions) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [manifest, setManifest] = useState<SaasCapabilityManifest | null>(null);
  const [pendingEmployee, setPendingEmployee] = useState<{
    scope: string;
    id: string;
  } | null>(null);
  const employeeScope = `${workspace?.organizationId}/${workspace?.workspaceId}/${workspace?.viewerId}`;
  const pendingEmployeeAssignmentId =
    pendingEmployee?.scope === employeeScope ? pendingEmployee.id : null;
  const setPendingEmployeeAssignmentId = useCallback(
    (id: string | null) => {
      setPendingEmployee(id ? { scope: employeeScope, id } : null);
    },
    [employeeScope],
  );
  const [activeId, updateActiveId] = useState<string | null>(null);
  const [selection] = useState(createSessionSelection);
  const [history, setHistory] = useState<History | null>(null);
  // Like DSH's retained Session bindings, switch the visible snapshot by ID
  // synchronously. This adapter reads Allrice's tenant-scoped HTTP history.
  // Nothing is persisted to browser storage or shared with another viewer.
  const historyCache = useRef(new Map<string, CachedHistory>());
  const historyScope = useRef('');
  const prefetches = useRef(
    new Map<
      string,
      {
        controller: AbortController;
        promise: Promise<History | null>;
      }
    >(),
  );
  const seededSession = useRef<string | null>(null);
  const historyRequestGeneration = useRef(0);
  const historyRequest = useRef<AbortController | null>(null);
  const setActiveId = useCallback(
    (sessionId: string | null, fresh = false) => {
      // Invalidate synchronously when selected, before the next render/effect.
      const changed = selection.select(sessionId);
      if (fresh && !changed) selection.invalidate();
      if (changed || fresh) {
        historyRequestGeneration.current += 1;
        historyRequest.current?.abort();
        seededSession.current = null;
        setHistory((current) => {
          if (current) rememberHistory(historyCache.current, current);
          return sessionId
            ? (historyCache.current.get(sessionId)?.value ?? null)
            : null;
        });
      }
      updateActiveId(sessionId);
      rememberSessionLocation(sessionId);
    },
    [selection],
  );

  const tenantOrganizationId = workspace?.organizationId;
  const tenantWorkspaceId = workspace?.workspaceId;
  const tenantHeaders = useMemo<Record<string, string>>(
    () =>
      tenantOrganizationId && tenantWorkspaceId
        ? {
            'x-allrice-organization-id': tenantOrganizationId,
            'x-allrice-workspace-id': tenantWorkspaceId,
          }
        : ({} as Record<string, string>),
    [tenantOrganizationId, tenantWorkspaceId],
  );

  const loadWorkspace = useCallback(async () => {
    const scope = selection.capture();
    const [workspaceResult, capabilityResult] = await Promise.all([
      fetch('/api/v1/workspace', { cache: 'no-store' }).then(
        readJson<{ workspace: Workspace }>,
      ),
      fetch('/api/v1/saas/capabilities', { cache: 'no-store' }).then(
        readJson<{ capabilities: SaasCapabilityManifest }>,
      ),
    ]);
    const nextWorkspace = workspaceResult.workspace;
    const nextScope = `${nextWorkspace.organizationId}/${nextWorkspace.workspaceId}/${nextWorkspace.viewerId}`;
    if (historyScope.current !== nextScope) {
      historyScope.current = nextScope;
      historyCache.current.clear();
      for (const pending of prefetches.current.values())
        pending.controller.abort();
      prefetches.current.clear();
      historyRequestGeneration.current++;
      historyRequest.current?.abort();
      setHistory(null);
    }
    const authorized = new Set(
      nextWorkspace.sessions.filter((s) => !s.archivedAt).map((s) => s.id),
    );
    for (const id of historyCache.current.keys())
      if (!authorized.has(id)) historyCache.current.delete(id);
    for (const [id, pending] of prefetches.current) {
      if (!authorized.has(id)) {
        pending.controller.abort();
        prefetches.current.delete(id);
      }
    }
    const params = new URLSearchParams(window.location.search);
    const linked = params.get('session');
    const requested = scope.sessionId ?? linked;
    // The sidebar is only the first page (30 Sessions), not an authorization
    // index. A valid old deep link must be read through the normal scoped
    // history endpoint before adding it to this local list.
    if (
      scope.current() &&
      requested &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requested) &&
      !nextWorkspace.sessions.some((session) => session.id === requested)
    ) {
      const response = await fetch(
        `/api/v1/sessions/${requested}?workspaceId=${nextWorkspace.workspaceId}`,
        {
          cache: 'no-store',
          headers: {
            'x-allrice-organization-id': nextWorkspace.organizationId,
            'x-allrice-workspace-id': nextWorkspace.workspaceId,
          },
        },
      );
      if (response.ok) {
        const result = await readJson<{ history: History }>(response);
        if (
          scope.current() &&
          result.history.session.id === requested &&
          !result.history.session.archivedAt
        ) {
          rememberHistory(historyCache.current, result.history, true);
          nextWorkspace.sessions = [
            result.history.session,
            ...nextWorkspace.sessions,
          ];
        }
      } else if (![403, 404].includes(response.status)) {
        // A transient failure must not silently open a different task.
        await readJson(response);
      }
    }
    setWorkspace(nextWorkspace);
    setManifest(capabilityResult.capabilities);
    if (scope.current()) {
      const current = scope.sessionId;
      if (
        !current &&
        linked &&
        workspaceResult.workspace.sessions.some(
          (s) => s.id === linked && !s.archivedAt,
        )
      ) {
        setActiveId(linked);
        return;
      }
      if (
        current &&
        workspaceResult.workspace.sessions.some(
          (session) => session.id === current && !session.archivedAt,
        )
      ) {
        return;
      }
      if (params.has('employee') && !linked) {
        setActiveId(null, true);
        return;
      }
      setActiveId(
        workspaceResult.workspace.sessions.find(
          (session) => !session.archivedAt,
        )?.id ?? null,
      );
    }
  }, [selection, setActiveId]);

  const prefetchHistory = useCallback(
    (sessionId: string) => {
      if (
        !tenantWorkspaceId ||
        historyScope.current !== employeeScope ||
        selection.capture().sessionId === sessionId ||
        !workspace?.sessions.some((s) => s.id === sessionId && !s.archivedAt) ||
        historyCache.current.has(sessionId) ||
        prefetches.current.has(sessionId) ||
        prefetches.current.size >= 2
      )
        return;
      const controller = new AbortController();
      const promise = fetch(
        `/api/v1/sessions/${sessionId}?workspaceId=${tenantWorkspaceId}`,
        {
          cache: 'no-store',
          headers: tenantHeaders,
          signal: controller.signal,
        },
      )
        .then(readJson<{ history: History }>)
        .then((result) => {
          if (
            controller.signal.aborted ||
            historyScope.current !== employeeScope ||
            result.history.session.id !== sessionId
          )
            return null;
          rememberHistory(historyCache.current, result.history, true);
          return result.history;
        })
        .catch(() => null)
        .finally(() => {
          if (prefetches.current.get(sessionId)?.controller === controller)
            prefetches.current.delete(sessionId);
        });
      prefetches.current.set(sessionId, { controller, promise });
    },
    [
      employeeScope,
      selection,
      tenantHeaders,
      tenantWorkspaceId,
      workspace?.sessions,
    ],
  );

  const loadHistory = useCallback(
    async (sessionId: string) => {
      const scope = selection.capture();
      // An old POST callback must not become the newest history request.
      if (
        !tenantWorkspaceId ||
        scope.sessionId !== sessionId ||
        historyScope.current !== employeeScope
      )
        return;
      const requestGeneration = ++historyRequestGeneration.current;
      historyRequest.current?.abort();
      const cached = historyCache.current.get(sessionId);
      if (cached?.prefetched && Date.now() - cached.loadedAt < 3000) {
        cached.prefetched = false;
        setHistory(cached.value);
        return;
      }
      const queued = prefetches.current.get(sessionId);
      const pending = queued?.controller.signal.aborted ? undefined : queued;
      const controller = pending?.controller ?? new AbortController();
      historyRequest.current = controller;
      const current = () =>
        scope.current() &&
        historyScope.current === employeeScope &&
        requestGeneration === historyRequestGeneration.current &&
        !controller.signal.aborted;
      try {
        let value = pending ? await pending.promise : null;
        if (!current()) return;
        if (!value) {
          const response = await fetch(
            `/api/v1/sessions/${sessionId}?workspaceId=${tenantWorkspaceId}`,
            {
              cache: 'no-store',
              headers: tenantHeaders,
              signal: controller.signal,
            },
          );
          if (!current()) return;
          if ([401, 403, 404].includes(response.status)) {
            historyCache.current.delete(sessionId);
            setHistory(null);
          }
          value = (await readJson<{ history: History }>(response)).history;
        }
        if (current() && value.session.id === sessionId) {
          rememberHistory(historyCache.current, value);
          setHistory(value);
        }
      } catch (cause) {
        if (current()) throw cause;
      } finally {
        if (historyRequest.current === controller)
          historyRequest.current = null;
      }
    },
    [employeeScope, selection, tenantHeaders, tenantWorkspaceId],
  );

  const updateLocalHistory = useCallback(
    (update: SetStateAction<History | null>) => {
      // A background refresh predating a send/queue edit must never erase its receipt.
      historyRequestGeneration.current++;
      historyRequest.current?.abort();
      setHistory(update);
    },
    [],
  );

  useEffect(() => {
    if (!activeId || seededSession.current === activeId) return;
    void loadHistory(activeId).catch((cause) =>
      setError(cause instanceof Error ? cause.message : '会话加载失败'),
    );
  }, [activeId, loadHistory, setError]);

  useEffect(() => {
    if (!history || history.session.id !== activeId) return;
    // Warm only the nearest two recent conversations after the current one loads.
    const timer = setTimeout(() => {
      for (const session of (workspace?.sessions ?? [])
        .filter((s) => s.id !== activeId && !s.archivedAt)
        .slice(0, 2))
        prefetchHistory(session.id);
    }, 150);
    return () => clearTimeout(timer);
  }, [activeId, history?.session.id, prefetchHistory, workspace?.sessions]);

  const createSession = useCallback(
    async (title: string, targetEmployeeAssignmentId?: string) => {
      if (!workspace) return null;
      const scope = selection.capture();
      const requestedEmployee = new URLSearchParams(window.location.search).get(
        'employee',
      );
      const explicitAssignment =
        targetEmployeeAssignmentId ?? pendingEmployeeAssignmentId;
      const employee = explicitAssignment
        ? workspace.employees.find((item) => item.id === explicitAssignment)
        : requestedEmployee
          ? workspace.employees.find(
              (item) => item.employeeId === requestedEmployee,
            )
          : (workspace.employees.find((item) => item.isDefault) ??
            workspace.employees[0]);
      if (!employee)
        throw new Error('当前账号未分配此员工，请检查登录账号和发布目标');
      const result = await readJson<{ session: Session }>(
        await fetch('/api/v1/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...tenantHeaders },
          body: JSON.stringify({
            workspaceId: workspace.workspaceId,
            employeeAssignmentId: employee.id,
            title: title.trim().slice(0, 60) || '新的工作',
          }),
        }),
      );
      // The server may have created it, but a late response cannot steal the
      // user's newer selection or begin sending its draft in that Session.
      if (!scope.current()) return null;
      // A newly-created Session already has the authoritative empty baseline.
      // Invalidate any older history response before publishing that baseline
      // so it cannot overwrite the first optimistic turn.
      historyRequestGeneration.current += 1;
      setWorkspace((current) =>
        current
          ? { ...current, sessions: [result.session, ...current.sessions] }
          : current,
      );
      setActiveId(result.session.id);
      seededSession.current = result.session.id;
      setHistory({
        session: result.session,
        messages: [],
        contextStatus: {
          percentage: 0,
          pressureTokens: 0,
          thresholdTokens: 40_000,
          compactionDue: false,
        },
        nativeContextStatus: null,
      });
      return result.session.id;
    },
    [
      selection,
      setActiveId,
      tenantHeaders,
      workspace,
      pendingEmployeeAssignmentId,
    ],
  );

  useEffect(() => {
    loadWorkspace().catch((cause) =>
      setError(cause instanceof Error ? cause.message : '工作区加载失败'),
    );
  }, [loadWorkspace, setError]);

  useEffect(
    () => () => {
      selection.invalidate();
      historyRequest.current?.abort();
      for (const pending of prefetches.current.values())
        pending.controller.abort();
      prefetches.current.clear();
      historyCache.current.clear();
    },
    [selection],
  );

  const requestedEmployee =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('employee');
  const newSessionEmployee = pendingEmployeeAssignmentId
    ? workspace?.employees.find(
        (item) => item.id === pendingEmployeeAssignmentId,
      )
    : requestedEmployee
      ? workspace?.employees.find(
          (item) => item.employeeId === requestedEmployee,
        )
      : (workspace?.employees.find((item) => item.isDefault) ??
        workspace?.employees[0]);
  return {
    newSessionEmployee,
    setPendingEmployeeAssignmentId,
    activeId,
    captureSelection: selection.capture,
    createSession,
    history: history?.session.id === activeId ? history : null,
    loadHistory,
    loadWorkspace,
    prefetchHistory,
    manifest,
    setActiveId,
    setHistory: updateLocalHistory,
    tenantHeaders,
    workspace,
  };
}
