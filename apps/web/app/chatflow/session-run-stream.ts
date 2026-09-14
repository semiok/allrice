import type { ChatFlowEventEnvelope } from '@allrice/contracts';

import { mergeChatFlowEvents } from '../../lib/chatflow/run-event-buffer';

import type { History, RunTrace, RunView } from './chatflow-types';
import { readJson } from './chatflow-utils';

interface SessionRunStreamOptions {
  sessionId: string | null;
  workspaceId: string | undefined;
  loadHistory: (sessionId: string) => Promise<void>;
  loadWorkspace: () => Promise<void>;
  setError: (message: string) => void;
  tenantHeaders: Record<string, string>;
}

interface Snapshot {
  runViews: Record<string, RunView>;
  runTraces: Record<string, RunTrace>;
}

function reconnectDelay(signal: AbortSignal, reconnects: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.min(300 * 2 ** reconnects, 3_000));
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

/** UI ownership, not authorization. Reset invalidates even fetches ignoring abort. */
export function createSessionRunStream({
  sessionId,
  workspaceId,
  loadHistory,
  loadWorkspace,
  setError,
  tenantHeaders,
}: SessionRunStreamOptions) {
  let active = false;
  let generation = 0;
  let snapshot: Snapshot = { runViews: {}, runTraces: {} };
  const listeners = new Set<() => void>();
  const activeStreams = new Map<string, AbortController>();
  const runEventBuffers = new Map<string, ChatFlowEventEnvelope[]>();
  const terminalRunIds = new Set<string>();
  const loadedTraceIds = new Set<string>();
  const traceLoads = new Map<string, AbortController>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const updateView = (runId: string, view: RunView) =>
    publish({ ...snapshot, runViews: { ...snapshot.runViews, [runId]: view } });
  const updateTrace = (runId: string, trace: RunTrace) =>
    publish({
      ...snapshot,
      runTraces: { ...snapshot.runTraces, [runId]: trace },
    });
  const resetRunState = () => {
    generation += 1;
    for (const controller of activeStreams.values()) controller.abort();
    for (const controller of traceLoads.values()) controller.abort();
    activeStreams.clear();
    traceLoads.clear();
    runEventBuffers.clear();
    terminalRunIds.clear();
    loadedTraceIds.clear();
    publish({ runViews: {}, runTraces: {} });
  };
  const streamRun = async (runId: string, sourceSessionId = sessionId) => {
    if (
      !active ||
      !sessionId ||
      sourceSessionId !== sessionId ||
      !workspaceId ||
      activeStreams.has(runId) ||
      terminalRunIds.has(runId)
    )
      return;
    const controller = new AbortController();
    const startedGeneration = generation;
    const current = () =>
      active && generation === startedGeneration && !controller.signal.aborted;
    activeStreams.set(runId, controller);
    let accumulated = runEventBuffers.get(runId) ?? [];
    let cursor: string | null = accumulated.at(-1)?.cursor ?? null;
    let reconnects = 0;
    let terminal = false;
    updateView(runId, {
      runId,
      status: 'connecting',
      cursor,
      reconnects: 0,
      events: mergeChatFlowEvents(
        snapshot.runViews[runId]?.events ?? [],
        accumulated,
      ),
    });
    try {
      while (!terminal && reconnects <= 6 && current()) {
        try {
          const headers: Record<string, string> = { ...tenantHeaders };
          if (cursor) headers['last-event-id'] = cursor;
          const response = await fetch(
            `/api/v1/runs/${runId}/events?workspaceId=${workspaceId}`,
            { cache: 'no-store', headers, signal: controller.signal },
          );
          if (!current()) return;
          if (!response.ok || !response.body) await readJson(response);
          if (!current()) return;
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          updateView(runId, {
            ...(snapshot.runViews[runId] ?? {
              runId,
              cursor,
              reconnects,
              events: accumulated,
            }),
            status: 'running',
          });
          try {
            while (current()) {
              const chunk = await reader.read();
              if (!current()) return;
              if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              const blocks = buffer.split('\n\n');
              buffer = blocks.pop() ?? '';
              for (const block of blocks) {
                if (!current()) return;
                const data = block
                  .split('\n')
                  .filter((line) => line.startsWith('data: '))
                  .map((line) => line.slice(6))
                  .join('\n');
                if (!data) continue;
                const event = JSON.parse(data) as ChatFlowEventEnvelope;
                cursor = event.cursor;
                accumulated = mergeChatFlowEvents(accumulated, [event]);
                runEventBuffers.set(runId, accumulated);
                terminal = [
                  'run.succeeded',
                  'run.failed',
                  'run.canceled',
                  'run.needs_attention',
                ].includes(event.type);
                updateView(runId, {
                  runId,
                  status:
                    event.type === 'run.failed'
                      ? 'failed'
                      : event.type === 'run.canceled'
                        ? 'canceled'
                        : terminal
                          ? 'completed'
                          : 'running',
                  cursor,
                  reconnects,
                  events: mergeChatFlowEvents(
                    snapshot.runViews[runId]?.events ?? [],
                    accumulated,
                  ),
                });
              }
            }
          } finally {
            reader.releaseLock();
          }
          if (!current()) return;
          if (!terminal) {
            reconnects += 1;
            updateView(runId, {
              ...(snapshot.runViews[runId] ?? {
                runId,
                status: 'connecting',
                cursor,
                events: accumulated,
              }),
              reconnects,
            });
          }
        } catch (cause) {
          if (!current()) return;
          reconnects += 1;
          updateView(runId, {
            ...(snapshot.runViews[runId] ?? {
              runId,
              cursor,
              events: accumulated,
            }),
            status: 'connecting',
            reconnects,
          });
          if (reconnects > 6) {
            setError(
              cause instanceof Error
                ? `实时连接恢复失败：${cause.message}`
                : '实时连接恢复失败',
            );
            break;
          }
        }
        if (!terminal && reconnects <= 6 && current())
          await reconnectDelay(controller.signal, reconnects);
      }
      if (!current()) return;
      if (terminal) {
        terminalRunIds.add(runId);
        loadedTraceIds.add(runId);
        updateTrace(runId, {
          status: 'loaded',
          events: mergeChatFlowEvents(
            snapshot.runTraces[runId]?.events ?? [],
            accumulated,
          ),
        });
      }
      await loadHistory(sessionId).catch(() => undefined);
      if (current()) await loadWorkspace().catch(() => undefined);
    } finally {
      // An older generation can finish after this Run already has a new stream.
      if (activeStreams.get(runId) === controller) activeStreams.delete(runId);
    }
  };
  const loadRunTrace = async (runId: string) => {
    if (
      !active ||
      !sessionId ||
      !workspaceId ||
      loadedTraceIds.has(runId) ||
      traceLoads.has(runId)
    )
      return;
    const controller = new AbortController();
    const startedGeneration = generation;
    const current = () =>
      active && generation === startedGeneration && !controller.signal.aborted;
    traceLoads.set(runId, controller);
    updateTrace(runId, {
      status: 'loading',
      events: snapshot.runTraces[runId]?.events ?? [],
    });
    try {
      const response = await fetch(
        `/api/v1/runs/${runId}/events?workspaceId=${workspaceId}&format=json`,
        {
          cache: 'no-store',
          headers: { ...tenantHeaders, accept: 'application/json' },
          signal: controller.signal,
        },
      );
      if (!current()) return;
      const result = await readJson<{ events: ChatFlowEventEnvelope[] }>(
        response,
      );
      if (!current()) return;
      loadedTraceIds.add(runId);
      updateTrace(runId, {
        status: 'loaded',
        events: mergeChatFlowEvents(
          snapshot.runTraces[runId]?.events ?? [],
          result.events,
        ),
      });
    } catch {
      if (current()) updateTrace(runId, { status: 'failed', events: [] });
    } finally {
      if (traceLoads.get(runId) === controller) traceLoads.delete(runId);
    }
  };
  return {
    activate: () => {
      active = true;
    },
    deactivate: () => {
      active = false;
      resetRunState();
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resetRunState,
    streamRun,
    loadRunTrace,
    recoverRun: (runId: string) => {
      if (!active) return Promise.resolve();
      terminalRunIds.delete(runId);
      return streamRun(runId);
    },
    restoreHistory: (history: History | null) => {
      // A render can hold previous History until the new request resolves.
      if (!active || !sessionId || history?.session.id !== sessionId) return;
      for (const message of history.messages) {
        if (!message.runId) continue;
        if (message.status === 'pending') void streamRun(message.runId);
        else void loadRunTrace(message.runId);
      }
    },
  };
}
