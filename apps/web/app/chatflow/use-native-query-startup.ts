'use client';

import { useEffect, useState } from 'react';
import type { History, Workspace } from './chatflow-types';
import { createSessionRunStream } from './session-run-stream';
import { nativeSubagentReadyKey } from './use-native-subagents';

type Entry = { runId: string | null; pending: boolean };

/** Keep only a known first binding's read gate alive after leaving its Session. */
export function useNativeQueryStartup(
  workspace: Workspace | null,
  headers: Record<string, string>,
  activeId: string | null,
  history: History | null,
  readyKey: string,
) {
  const scope = JSON.stringify([
    workspace?.organizationId,
    workspace?.workspaceId,
    workspace?.viewerId,
    headers,
  ]);
  const [state, setState] = useState<{
    scope: string;
    entries: Record<string, Entry>;
  }>({ scope, entries: {} });
  const selected = history?.session.id === activeId ? history : null;
  const runId = selected?.messages.findLast((message) => message.runId)?.runId;
  const settled = selected?.messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.runId &&
      message.status !== 'pending',
  );
  const owned =
    !!workspace &&
    !!selected &&
    (!selected.session.ownerId ||
      selected.session.ownerId === workspace.viewerId);
  useEffect(() => {
    if (!owned || !activeId) return;
    setState((current) => {
      const entries = current.scope === scope ? current.entries : {};
      const previous = entries[activeId];
      const pending = !readyKey && !settled;
      // A disconnected/terminal observer releases the normal error handling.
      if (previous?.runId === (runId ?? null) && !previous.pending)
        return current;
      if (previous?.runId === (runId ?? null) && previous.pending === pending)
        return current;
      return {
        scope,
        entries: { ...entries, [activeId]: { runId: runId ?? null, pending } },
      };
    });
  }, [scope, owned, activeId, runId, readyKey, settled]);

  const entries = state.scope === scope ? state.entries : {};
  const observers = JSON.stringify(
    Object.entries(entries).filter(
      ([id, entry]) => id !== activeId && entry.pending && entry.runId,
    ),
  );
  useEffect(() => {
    const [, workspaceId, , headers] = JSON.parse(scope);
    const disposals: (() => void)[] = [];
    for (const [sessionId, entry] of JSON.parse(observers) as [
      string,
      Entry,
    ][]) {
      const stream = createSessionRunStream({
        sessionId,
        workspaceId,
        tenantHeaders: headers,
        loadHistory: async () => {},
        loadWorkspace: async () => {},
        setError: () => {},
      });
      const unsubscribe = stream.subscribe(() => {
        const view = stream.getSnapshot().runViews[entry.runId!];
        if (
          !nativeSubagentReadyKey(view) &&
          !view?.connectionError &&
          !['completed', 'failed', 'canceled'].includes(view?.status ?? '')
        )
          return;
        setState((current) =>
          current.scope === scope &&
          current.entries[sessionId]?.runId === entry.runId &&
          current.entries[sessionId]?.pending
            ? {
                ...current,
                entries: {
                  ...current.entries,
                  [sessionId]: { ...entry, pending: false },
                },
              }
            : current,
        );
      });
      stream.activate();
      void stream.streamRun(entry.runId!);
      disposals.push(() => {
        unsubscribe();
        stream.deactivate();
      });
    }
    return () => disposals.forEach((dispose) => dispose());
  }, [scope, observers]);
  return new Set(
    Object.entries(entries)
      .filter(([, entry]) => entry.pending)
      .map(([id]) => id),
  );
}
