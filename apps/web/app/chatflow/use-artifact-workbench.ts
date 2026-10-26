'use client';
import { artifactForDownloadLink } from '../../lib/chatflow/artifact-download-link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkbenchArtifact } from '@allrice/contracts';
import {
  artifactArrival,
  mergeArtifactPage,
  parseArtifactList,
  workbenchJson,
  type ArtifactCursor,
} from '../../lib/chatflow/workbench-model';

type Selection = {
  id: string | null;
  explicit: boolean;
};
type Data = {
  scope: string;
  artifacts: WorkbenchArtifact[];
  nextCursor: ArtifactCursor | null;
  selection: Selection;
  noticeId: string | null;
};
const empty = (scope: string): Data => ({
  scope,
  artifacts: [],
  nextCursor: null,
  selection: { id: null, explicit: false },
  noticeId: null,
});

export function useArtifactWorkbench({
  enabled,
  sessionId,
  workspaceId,
  tenantHeaders,
  onOpen,
  onClose,
  visible = false,
  viewerId,
}: {
  enabled: boolean;
  sessionId: string | null;
  workspaceId: string | undefined;
  tenantHeaders: Record<string, string>;
  onOpen: () => void;
  onClose: () => void;
  visible?: boolean;
  viewerId?: string | null;
}) {
  const owner = `${viewerId ?? ''}/${tenantHeaders['x-allrice-organization-id'] ?? ''}/${workspaceId ?? ''}`;
  const scope =
    enabled && sessionId && workspaceId ? `${owner}/${sessionId}` : '';
  const [data, setData] = useState<Data>(() => empty(''));
  // Retain the last visited session's catalog/selection like the native DSH
  // session surface. Content bodies still use their authenticated read APIs.
  const snapshots = useRef(new Map<string, Data>());
  useEffect(() => {
    snapshots.current.clear();
  }, [owner, enabled]);
  useEffect(() => {
    if (!data.scope.startsWith(`${owner}/`) || !enabled) return;
    const cache = snapshots.current;
    cache.delete(data.scope);
    cache.set(data.scope, data);
    while (cache.size > 8) cache.delete(cache.keys().next().value!);
  }, [data, owner, enabled]);
  const [selectionRequest, setSelectionRequest] = useState({
    scope: '',
    revision: 0,
  });
  const [status, setStatus] = useState({
    scope: '',
    error: '',
    loading: false,
  });
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const reload = useCallback(
    async (before?: ArtifactCursor) => {
      if (!scope) return;
      const token = ++generation.current;
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setStatus({ scope, error: '', loading: true });
      try {
        const page = parseArtifactList(
          await workbenchJson(
            `/api/v1/sessions/${sessionId}/artifacts?workspaceId=${workspaceId}${before ? `&before=${encodeURIComponent(JSON.stringify(before))}` : ''}`,
            tenantHeaders,
            { signal: request.signal },
          ),
        );
        if (
          page.artifacts.some(
            (a) =>
              a.version.sessionId !== sessionId ||
              a.version.workspaceId !== workspaceId,
          )
        )
          throw Error('成果所属会话不匹配');
        if (token !== generation.current) return;
        setData((previous) => {
          const current =
            previous.scope === scope
              ? previous
              : (snapshots.current.get(scope) ?? empty(scope));
          const artifacts = mergeArtifactPage(
            current.artifacts,
            page.artifacts,
          );
          return {
            scope,
            artifacts,
            nextCursor: page.nextCursor,
            ...(before
              ? { selection: current.selection, noticeId: current.noticeId }
              : artifactArrival(
                  current.artifacts,
                  artifacts,
                  current.selection,
                  current.noticeId,
                  visibleRef.current,
                )),
          };
        });
        setStatus({ scope, error: '', loading: false });
        return page.artifacts;
      } catch (cause) {
        if (token === generation.current && !request.signal.aborted) {
          if (
            cause instanceof Error &&
            'status' in cause &&
            [401, 403, 404].includes(Number(cause.status))
          ) {
            snapshots.current.delete(scope);
            setData(empty(scope));
          }
          // Keep the selected preview mounted on refresh failure.
          setStatus({
            scope,
            error: cause instanceof Error ? cause.message : '成果加载失败',
            loading: false,
          });
        }
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
  const show = useCallback(
    (id?: string, preserveCurrent = false) => {
      setData((previous) => {
        const current =
          previous.scope === scope
            ? previous
            : (snapshots.current.get(scope) ?? empty(scope));
        const requested =
          id ??
          (!preserveCurrent
            ? (current.selection.id ?? current.artifacts[0]?.id)
            : undefined);
        return {
          ...current,
          selection: requested
            ? {
                id: requested,
                explicit: id ? true : current.selection.explicit,
              }
            : preserveCurrent
              ? { ...current.selection, explicit: true }
              : current.selection,
          noticeId: requested === current.noticeId ? null : current.noticeId,
        };
      });
      if (!preserveCurrent)
        setSelectionRequest((value) => ({
          scope,
          revision: value.revision + 1,
        }));
      onOpen();
    },
    [scope, onOpen],
  );
  const resolveDownloadLink = useCallback(
    async (href: string, runId: string) => {
      let url: URL;
      try {
        url = new URL(
          href.replace(/\\+\//g, '/'),
          'https://artifact-link.invalid',
        );
      } catch {
        return false;
      }
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        !/^\/api\/v1\/files\/[a-f0-9-]{36}(?:\/download)?$/.test(url.pathname)
      )
        return false;
      const page = await reload();
      // An aborted/superseded or denied read must not navigate from another scope.
      if (!page) return true;
      const artifact = artifactForDownloadLink(
        href,
        page.filter((item) => item.provenance.runId === runId),
      );
      if (!artifact) return false;
      show(artifact.id);
      return true;
    },
    [reload, show],
  );
  const refresh = useCallback(
    async (before?: ArtifactCursor) => {
      await reload(before);
    },
    [reload],
  );
  const current =
    data.scope === scope
      ? data
      : (snapshots.current.get(scope) ?? empty(scope));
  return {
    scope,
    artifacts: current.artifacts,
    nextCursor: current.nextCursor,
    selectedId: current.selection.id,
    selectionRequest:
      selectionRequest.scope === scope ? selectionRequest.revision : 0,
    noticeId: current.noticeId,
    error: status.scope === scope ? status.error : '',
    loading: status.scope === scope && status.loading,
    reload: refresh,
    resolveDownloadLink,
    show,
    close: onClose,
  };
}
