'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkbenchArtifact } from '@allrice/contracts';
import {
  mergeArtifactPage,
  parseArtifactList,
  workbenchJson,
  type ArtifactCursor,
} from '../../lib/chatflow/workbench-model';

export function useArtifactWorkbench({
  enabled,
  sessionId,
  workspaceId,
  tenantHeaders,
}: {
  enabled: boolean;
  sessionId: string | null;
  workspaceId: string | undefined;
  tenantHeaders: Record<string, string>;
}) {
  const [data, setData] = useState<{
    scope: string;
    artifacts: WorkbenchArtifact[];
    nextCursor: ArtifactCursor | null;
  }>({ scope: '', artifacts: [], nextCursor: null });
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [opened, setOpened] = useState<{ scope: string; id: string | null } | null>(
      null,
    );
  const scope =
      enabled && sessionId && workspaceId ? `${workspaceId}/${sessionId}` : '',
    generation = useRef(0),
    dirty = useRef(false),
    controller = useRef<AbortController | null>(null);
  const noteDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const confirmNavigation = useCallback(
    () =>
      !dirty.current ||
      window.confirm(
        '有尚未保存的工件意见，离开会丢失这些本地编辑。仍要继续吗？',
      ),
    [],
  );
  const reload = useCallback(
    async (before?: ArtifactCursor) => {
      if (!scope) return;
      const token = ++generation.current;
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setLoading(true);
      setError('');
      try {
        const page = parseArtifactList(
          await workbenchJson(
            `/api/v1/sessions/${sessionId}/artifacts?workspaceId=${workspaceId}${before ? `&before=${encodeURIComponent(JSON.stringify(before))}` : ''}`,
            tenantHeaders,
            { signal: request.signal },
          ),
        );
        if (token === generation.current)
          setData((current) => ({
            scope,
            artifacts: mergeArtifactPage(
              current.scope === scope ? current.artifacts : [],
              page.artifacts,
            ),
            nextCursor: page.nextCursor,
          }));
      } catch (cause) {
        if (token === generation.current && !request.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '工件加载失败');
          setData({ scope, artifacts: [], nextCursor: null });
        }
      } finally {
        if (token === generation.current) setLoading(false);
      }
    },
    [scope, sessionId, workspaceId, tenantHeaders],
  );
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [reload]);
  const open = !!scope && opened?.scope === scope;
  const artifacts = data.scope === scope ? data.artifacts : [];
  const show = useCallback(
    (id: string | null = null) => {
      setOpened({ scope, id });
    },
    [scope],
  );
  const close = useCallback(() => setOpened(null), []);
  return {
    scope,
    artifacts,
    error,
    loading,
    nextCursor: data.scope === scope ? data.nextCursor : null,
    reload,
    open,
    selectedId: open ? opened.id : null,
    show,
    close,
    noteDirty,
    confirmNavigation,
  };
}
