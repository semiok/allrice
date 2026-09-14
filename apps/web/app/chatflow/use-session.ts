'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SaasCapabilityManifest } from '@allrice/contracts';

import type { History, Session, Workspace } from './chatflow-types';
import { readJson } from './chatflow-utils';
import { createSessionSelection } from './session-selection';

type UseSessionOptions = {
  setError: (message: string) => void;
};

export function useSession({ setError }: UseSessionOptions) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [manifest, setManifest] = useState<SaasCapabilityManifest | null>(null);
  const [activeId, updateActiveId] = useState<string | null>(null);
  const [selection] = useState(createSessionSelection);
  const [history, setHistory] = useState<History | null>(null);
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
      }
      updateActiveId(sessionId);
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
      readJson<{ workspace: Workspace }>(
        await fetch('/api/v1/workspace', { cache: 'no-store' }),
      ),
      readJson<{ capabilities: SaasCapabilityManifest }>(
        await fetch('/api/v1/saas/capabilities', { cache: 'no-store' }),
      ),
    ]);
    setWorkspace(workspaceResult.workspace);
    setManifest(capabilityResult.capabilities);
    if (scope.current()) {
      const current = scope.sessionId;
      const linked = new URLSearchParams(window.location.search).get('session');
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
      setActiveId(
        workspaceResult.workspace.sessions.find(
          (session) => !session.archivedAt,
        )?.id ?? null,
      );
    }
  }, [selection, setActiveId]);

  const loadHistory = useCallback(
    async (sessionId: string) => {
      const scope = selection.capture();
      // An old POST callback must not become the newest history request.
      if (!tenantWorkspaceId || scope.sessionId !== sessionId) return;
      const requestGeneration = ++historyRequestGeneration.current;
      historyRequest.current?.abort();
      const controller = new AbortController();
      historyRequest.current = controller;
      const current = () =>
        scope.current() &&
        requestGeneration === historyRequestGeneration.current &&
        !controller.signal.aborted;
      try {
        const response = await fetch(
          `/api/v1/sessions/${sessionId}?workspaceId=${tenantWorkspaceId}`,
          {
            cache: 'no-store',
            headers: tenantHeaders,
            signal: controller.signal,
          },
        );
        if (!current()) return;
        const result = await readJson<{ history: History }>(response);
        if (current() && result.history.session.id === sessionId)
          setHistory(result.history);
      } catch (cause) {
        if (current()) throw cause;
      } finally {
        if (historyRequest.current === controller)
          historyRequest.current = null;
      }
    },
    [selection, tenantHeaders, tenantWorkspaceId],
  );

  const createSession = useCallback(
    async (title: string) => {
      if (!workspace) return null;
      const scope = selection.capture();
      const employee =
        workspace.employees.find((item) => item.isDefault) ??
        workspace.employees[0];
      if (!employee) throw new Error('当前没有可用的 AI 员工');
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
    [selection, setActiveId, tenantHeaders, workspace],
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
    },
    [selection],
  );

  return {
    activeId,
    captureSelection: selection.capture,
    createSession,
    history,
    loadHistory,
    loadWorkspace,
    manifest,
    setActiveId,
    setHistory,
    tenantHeaders,
    workspace,
  };
}
