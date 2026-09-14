'use client';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';

import type { History, Workspace } from './chatflow-types';
import { createSessionRunStream } from './session-run-stream';

interface UseRunStreamOptions {
  activeId: string | null;
  history: History | null;
  loadHistory: (sessionId: string) => Promise<void>;
  loadWorkspace: () => Promise<void>;
  setError: (message: string) => void;
  tenantHeaders: Record<string, string>;
  workspace: Workspace | null;
}

/** Each selected Session owns its projection and async transport lifetime. */
export function useRunStream({
  activeId,
  history,
  loadHistory,
  loadWorkspace,
  setError,
  tenantHeaders,
  workspace,
}: UseRunStreamOptions) {
  const workspaceId = workspace?.workspaceId;
  // Polling Workspace must not interrupt the currently selected running turn.
  // A different Session gets an empty projection in its very first render,
  // before effects run and before its asynchronous History request completes.
  const stream = useMemo(
    () =>
      createSessionRunStream({
        sessionId: activeId,
        workspaceId,
        loadHistory,
        loadWorkspace,
        setError,
        tenantHeaders,
      }),
    [
      activeId,
      workspaceId,
      loadHistory,
      loadWorkspace,
      setError,
      tenantHeaders,
    ],
  );
  const snapshot = useSyncExternalStore(
    stream.subscribe,
    stream.getSnapshot,
    stream.getSnapshot,
  );
  useLayoutEffect(() => {
    stream.activate();
    return stream.deactivate;
  }, [stream]);
  useEffect(() => {
    stream.restoreHistory(history);
  }, [history, stream]);
  return {
    loadRunTrace: stream.loadRunTrace,
    recoverRun: stream.recoverRun,
    resetRunState: stream.resetRunState,
    runTraces: snapshot.runTraces,
    runViews: snapshot.runViews,
    streamRun: stream.streamRun,
  };
}
