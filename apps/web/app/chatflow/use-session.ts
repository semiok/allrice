'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SaasCapabilityManifest } from '@allrice/contracts';

import type { History, Session, Workspace } from './chatflow-types';
import { readJson } from './chatflow-utils';

type UseSessionOptions = {
  setError: (message: string) => void;
};

export function useSession({ setError }: UseSessionOptions) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [manifest, setManifest] = useState<SaasCapabilityManifest | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const historyRequestGeneration = useRef(0);

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
    setActiveId((current) => {
      if (
        current &&
        workspaceResult.workspace.sessions.some(
          (session) => session.id === current && !session.archivedAt,
        )
      ) {
        return current;
      }
      return (
        workspaceResult.workspace.sessions.find(
          (session) => !session.archivedAt,
        )?.id ?? null
      );
    });
  }, []);

  const loadHistory = useCallback(
    async (sessionId: string) => {
      if (!tenantWorkspaceId) return;
      const requestGeneration = ++historyRequestGeneration.current;
      const result = await readJson<{ history: History }>(
        await fetch(
          `/api/v1/sessions/${sessionId}?workspaceId=${tenantWorkspaceId}`,
          { cache: 'no-store', headers: tenantHeaders },
        ),
      );
      if (requestGeneration !== historyRequestGeneration.current) return;
      setHistory(result.history);
    },
    [tenantHeaders, tenantWorkspaceId],
  );

  const createSession = useCallback(
    async (title: string) => {
      if (!workspace) return null;
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
    [tenantHeaders, workspace],
  );

  useEffect(() => {
    loadWorkspace().catch((cause) =>
      setError(cause instanceof Error ? cause.message : '工作区加载失败'),
    );
  }, [loadWorkspace, setError]);

  return {
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
  };
}
