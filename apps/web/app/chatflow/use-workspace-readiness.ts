'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  WorkspaceReadinessSchema,
  type WorkspaceReadiness,
} from '@allrice/contracts';

export function useWorkspaceReadiness(input: {
  workspaceId?: string;
  organizationId?: string;
  viewerId?: string | null;
  sessionId: string | null;
  headers: Record<string, string>;
  visible: boolean;
}) {
  const { workspaceId, organizationId, viewerId, sessionId, headers, visible } =
    input;
  const scope = JSON.stringify([
    organizationId,
    workspaceId,
    viewerId,
    sessionId,
  ]);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    data: WorkspaceReadiness | null;
    error: string;
    loading: boolean;
  } | null>(null);
  const requests = useRef<{
    controller: AbortController;
    scope: string;
  } | null>(null);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const reload = useCallback(async () => {
    if (!workspaceId || !organizationId || !viewerId) return;
    requests.current?.controller.abort();
    const request = { controller: new AbortController(), scope };
    requests.current = request;
    const current = () =>
      requests.current === request && latestScope.current === scope;
    // Keep this scope's last check visible while refreshing the same cards.
    // A different member, workspace or session must never inherit that result.
    setSnapshot((previous) => ({
      scope,
      data: previous?.scope === scope ? previous.data : null,
      error: '',
      loading: true,
    }));
    const timeout = window.setTimeout(() => request.controller.abort(), 15_000);
    try {
      const query = new URLSearchParams({ workspaceId });
      if (sessionId) query.set('sessionId', sessionId);
      const response = await fetch(`/api/v1/workspace/readiness?${query}`, {
        headers,
        cache: 'no-store',
        signal: request.controller.signal,
      });
      if (!response.ok)
        throw Error('能力状态读取失败，请刷新；当前不代表已就绪。');
      const data = WorkspaceReadinessSchema.parse(await response.json());
      if (
        data.organizationId !== organizationId ||
        data.workspaceId !== workspaceId ||
        data.viewerId !== viewerId ||
        data.sessionId !== sessionId
      )
        throw Error('能力状态与当前会话不一致，请刷新。');
      if (current() && !request.controller.signal.aborted)
        setSnapshot({ scope, data, error: '', loading: false });
    } catch {
      if (current())
        setSnapshot({
          scope,
          data: null,
          error: request.controller.signal.aborted
            ? '能力状态刷新超时，请重试。'
            : '能力状态未知，请刷新重试或重新登录。',
          loading: false,
        });
    } finally {
      window.clearTimeout(timeout);
      if (current()) requests.current = null;
    }
  }, [workspaceId, organizationId, viewerId, sessionId, scope, headers]);
  useEffect(() => {
    // The composer also uses readiness while the panel is closed.
    void reload();
    return () => {
      requests.current?.controller.abort();
      requests.current = null;
    };
  }, [reload]);
  useEffect(() => {
    // Check once when opened, sharing any check already running for this scope.
    // Subsequent updates are explicit; polling/focus refreshes interrupt reading.
    if (visible && !requests.current) void reload();
  }, [reload, visible]);
  return {
    data: snapshot?.scope === scope ? snapshot.data : null,
    error: snapshot?.scope === scope ? snapshot.error : '',
    loading: snapshot?.scope === scope ? snapshot.loading : true,
    reload,
  };
}
