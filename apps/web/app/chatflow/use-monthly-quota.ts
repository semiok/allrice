'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  UserMonthlyQuotaSchema,
  type UserMonthlyQuota,
} from '@allrice/contracts';

export function useMonthlyQuota(input: {
  workspaceId?: string;
  organizationId?: string;
  viewerId?: string | null;
  headers: Record<string, string>;
  refreshKey: string;
}) {
  const { workspaceId, organizationId, viewerId, headers, refreshKey } = input;
  const scope = JSON.stringify([organizationId, workspaceId, viewerId]);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    data: UserMonthlyQuota | null;
    failed: boolean;
  } | null>(null);
  const request = useRef<AbortController | null>(null);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const reload = useCallback(async () => {
    if (!workspaceId || !organizationId || !viewerId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = () =>
      request.current === controller && latestScope.current === scope;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const query = new URLSearchParams({ workspaceId });
      const response = await fetch(`/api/v1/workspace/monthly-quota?${query}`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw Error('quota_unavailable');
      const data = UserMonthlyQuotaSchema.parse(await response.json());
      if (
        data.organizationId !== organizationId ||
        data.workspaceId !== workspaceId ||
        data.userId !== viewerId
      )
        throw Error('quota_scope_mismatch');
      if (current() && !controller.signal.aborted)
        setSnapshot({ scope, data, failed: false });
    } catch {
      if (current()) setSnapshot({ scope, data: null, failed: true });
    } finally {
      window.clearTimeout(timeout);
      if (current()) request.current = null;
    }
  }, [workspaceId, organizationId, viewerId, headers, scope]);
  useEffect(() => {
    void reload();
    const visible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const timer = window.setInterval(visible, 30_000);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      request.current?.abort();
      request.current = null;
      window.clearInterval(timer);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [reload, refreshKey]);
  return {
    data: snapshot?.scope === scope ? snapshot.data : null,
    failed: snapshot?.scope === scope && snapshot.failed,
    reload,
  };
}
