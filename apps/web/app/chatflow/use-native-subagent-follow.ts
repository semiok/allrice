'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  NativeSubagentSnapshot,
  NativeSubagentSummary,
} from '@allrice/contracts';
import { followNativeSubagents } from './native-subagent-follow';

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
    enabled ? summary.rootId : null,
    enabled ? childId : null,
    revision,
  ]);
  const running = child?.kind === 'child' ? child.running : null;
  const [probe, setProbe] = useState(0);
  const previous = useRef({ scope, running });
  const restarting =
    previous.current.scope === scope &&
    previous.current.running === false &&
    running === true;
  useEffect(() => {
    if (restarting) setProbe((value) => value + 1);
    previous.current = { scope, running };
  }, [scope, running, restarting]);
  const key = JSON.stringify([scope, probe]);
  const [state, setState] = useState<{ key: string; view: View }>({
    key: '',
    view: null,
  });
  useEffect(() => {
    const [scope] = JSON.parse(key);
    const [workspaceId, sessionId, headers, rootId, childId] =
      JSON.parse(scope);
    const abort = new AbortController();
    const publish = (view: View) => {
      if (!abort.signal.aborted) setState({ key, view });
    };
    publish(null);
    if (rootId && childId && navigator.onLine !== false)
      void (async () => {
        let snapshot: NativeSubagentSnapshot | null = null,
          terminal = false;
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
              if (terminal) throw new Error('event after terminal');
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
              } else if (event.type === 'terminal') {
                if (
                  event.childId !== childId ||
                  (event.summary && event.summary.rootId !== rootId)
                )
                  throw new Error('terminal scope changed');
                terminal = true;
                snapshot = null;
                publish(event.summary);
              } else if (event.type === 'clear') {
                snapshot = null;
                publish(null);
              } else if (event.summary.rootId !== rootId)
                throw new Error('directory scope changed');
            },
          );
          if (!terminal) publish(null);
        } catch {
          publish('error');
        }
      })();
    return () => abort.abort();
  }, [key]);
  return {
    view: !restarting && state.key === key ? state.view : null,
    enabled,
  };
}
