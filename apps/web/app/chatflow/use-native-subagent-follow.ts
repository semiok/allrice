'use client';
import { useEffect, useState } from 'react';
import type { NativeSubagentSummary } from '@allrice/contracts';
import {
  followNativeSubagents,
  type NativeSubagentSnapshot,
} from './native-subagent-follow';

type View = NativeSubagentSnapshot | NativeSubagentSummary | null | 'error';
export function useNativeSubagentFollow(
  workspaceId: string,
  sessionId: string,
  headers: Record<string, string>,
  summary: NativeSubagentSummary | null,
  childId: string | null,
  revision: string,
) {
  const child = summary?.descendants.find((entry) => entry.id === childId);
  const enabled =
    summary?.root.source === 'live' &&
    child?.kind === 'child' &&
    child.observation.source === 'live';
  const scope = JSON.stringify([
    workspaceId,
    sessionId,
    headers,
    childId,
    revision,
  ]);
  const [state, setState] = useState<{ key: string; view: View }>({
    key: '',
    view: null,
  });
  const [previousScope, previousRoot] = state.key ? JSON.parse(state.key) : [];
  const rootId =
    (previousScope === scope && (!summary || summary.rootId === previousRoot)
      ? previousRoot
      : null) ?? (enabled ? summary.rootId : null);
  const key = JSON.stringify([scope, rootId]);
  useEffect(() => {
    const [scope, rootId] = JSON.parse(key);
    const [workspaceId, sessionId, headers, childId] = JSON.parse(scope);
    const abort = new AbortController();
    const publish = (view: View) => {
      if (!abort.signal.aborted) setState({ key, view });
    };
    publish(null);
    if (rootId && childId && navigator.onLine !== false)
      void (async () => {
        let snapshot: NativeSubagentSnapshot | null = null;
        try {
          const query = new URLSearchParams({
            workspaceId,
            follow: 'true',
            childId,
          });
          await followNativeSubagents(
            `/api/v1/sessions/${encodeURIComponent(sessionId)}/subagents?${query}`,
            headers,
            abort.signal,
            (event) => {
              if (event.type === 'snapshot') {
                if (
                  event.snapshot.rootId !== rootId ||
                  event.snapshot.childId !== childId
                )
                  throw new Error('snapshot scope changed');
                snapshot = event.snapshot;
                publish(snapshot);
              } else if (event.type === 'display') {
                if (
                  !snapshot ||
                  event.rootId !== rootId ||
                  event.childId !== childId ||
                  event.display.instanceId !== snapshot.stream.instanceId ||
                  event.hostEpoch !== snapshot.hostEpoch
                )
                  throw new Error('display scope changed');
                snapshot = { ...snapshot, stream: event.display };
                publish(snapshot);
              } else if (event.type === 'summary') {
                if (
                  event.childId !== childId ||
                  (event.summary && event.summary.rootId !== rootId)
                )
                  throw new Error('summary scope changed');
                snapshot = null;
                publish(event.summary);
              } else if (event.type === 'clear') {
                snapshot = null;
                publish(null);
              } else {
                if (event.summary.rootId !== rootId)
                  throw new Error('directory scope changed');
                const child = event.summary.descendants.find(
                  (entry) => entry.id === childId,
                );
                if (
                  child?.kind !== 'child' ||
                  child.observation.source !== 'live'
                ) {
                  snapshot = null;
                  publish(event.summary);
                }
              }
            },
          );
          publish(null);
        } catch {
          publish('error');
        }
      })();
    return () => abort.abort();
  }, [key]);
  return {
    view: state.key === key ? state.view : null,
    enabled: !!rootId && !!childId,
  };
}
