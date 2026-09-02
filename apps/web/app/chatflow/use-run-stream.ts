'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatFlowEventEnvelope } from '@allrice/contracts';

import { mergeChatFlowEvents } from '../../lib/chatflow/run-event-buffer';

import type { RunTrace, RunView, Workspace } from './chatflow-types';
import { readJson } from './chatflow-utils';

interface UseRunStreamOptions {
  activeId: string | null;
  loadHistory: (sessionId: string) => Promise<void>;
  loadWorkspace: () => Promise<void>;
  setError: (message: string) => void;
  tenantHeaders: Record<string, string>;
  workspace: Workspace | null;
}

/**
 * Owns the durable DSH run stream and trace projection state.
 *
 * Session selection still decides when streams and traces start. This hook
 * only centralizes the transport lifecycle so ChatFlow's UI does not own SSE
 * cursors, reconnect buffers, or terminal-run bookkeeping.
 */
export function useRunStream({
  activeId,
  loadHistory,
  loadWorkspace,
  setError,
  tenantHeaders,
  workspace,
}: UseRunStreamOptions) {
  const [runViews, setRunViews] = useState<Record<string, RunView>>({});
  const [runTraces, setRunTraces] = useState<Record<string, RunTrace>>({});
  const activeStreams = useRef(new Map<string, AbortController>());
  const runEventBuffers = useRef(new Map<string, ChatFlowEventEnvelope[]>());
  const terminalRunIds = useRef(new Set<string>());
  const loadedTraceIds = useRef(new Set<string>());
  const traceLoads = useRef(new Set<string>());

  const resetRunState = useCallback(() => {
    for (const controller of activeStreams.current.values()) {
      controller.abort();
    }
    activeStreams.current.clear();
    runEventBuffers.current.clear();
    terminalRunIds.current.clear();
    loadedTraceIds.current.clear();
    traceLoads.current.clear();
    setRunViews({});
    setRunTraces({});
  }, []);

  const streamRun = useCallback(
    async (runId: string) => {
      if (
        !workspace ||
        activeStreams.current.has(runId) ||
        terminalRunIds.current.has(runId)
      )
        return;
      const controller = new AbortController();
      activeStreams.current.set(runId, controller);
      let accumulated = runEventBuffers.current.get(runId) ?? [];
      let cursor: string | null = accumulated.at(-1)?.cursor ?? null;
      let reconnects = 0;
      let terminal = false;
      setRunViews((current) => ({
        ...current,
        [runId]: {
          runId,
          status: 'connecting',
          cursor,
          reconnects: 0,
          events: mergeChatFlowEvents(
            current[runId]?.events ?? [],
            accumulated,
          ),
        },
      }));
      while (!terminal && reconnects <= 6 && !controller.signal.aborted) {
        try {
          const headers: Record<string, string> = { ...tenantHeaders };
          if (cursor) headers['last-event-id'] = cursor;
          const response = await fetch(
            `/api/v1/runs/${runId}/events?workspaceId=${workspace.workspaceId}`,
            { cache: 'no-store', headers, signal: controller.signal },
          );
          if (!response.ok || !response.body) await readJson(response);
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          setRunViews((current) => ({
            ...current,
            [runId]: {
              ...(current[runId] ?? {
                runId,
                cursor,
                reconnects,
                events: accumulated,
              }),
              status: 'running',
            },
          }));
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() ?? '';
            for (const block of blocks) {
              const data = block
                .split('\n')
                .filter((line) => line.startsWith('data: '))
                .map((line) => line.slice(6))
                .join('\n');
              if (!data) continue;
              const event = JSON.parse(data) as ChatFlowEventEnvelope;
              cursor = event.cursor;
              accumulated = mergeChatFlowEvents(accumulated, [event]);
              runEventBuffers.current.set(runId, accumulated);
              terminal = [
                'run.succeeded',
                'run.failed',
                'run.canceled',
                'run.needs_attention',
              ].includes(event.type);
              setRunViews((current) => ({
                ...current,
                [runId]: {
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
                    current[runId]?.events ?? [],
                    accumulated,
                  ),
                },
              }));
            }
          }
          if (!terminal) {
            reconnects += 1;
            setRunViews((current) => ({
              ...current,
              [runId]: current[runId]
                ? { ...current[runId], reconnects }
                : {
                    runId,
                    status: 'connecting',
                    cursor,
                    reconnects,
                    events: accumulated,
                  },
            }));
          }
        } catch (cause) {
          if (controller.signal.aborted) break;
          reconnects += 1;
          setRunViews((current) => ({
            ...current,
            [runId]: current[runId]
              ? { ...current[runId], status: 'connecting', reconnects }
              : {
                  runId,
                  status: 'connecting',
                  cursor,
                  reconnects,
                  events: accumulated,
                },
          }));
          if (reconnects > 6) {
            setError(
              cause instanceof Error
                ? `实时连接恢复失败：${cause.message}`
                : '实时连接恢复失败',
            );
            break;
          }
        }
        if (!terminal && reconnects <= 6) {
          await new Promise((resolve) =>
            window.setTimeout(resolve, Math.min(300 * 2 ** reconnects, 3_000)),
          );
        }
      }
      if (activeStreams.current.get(runId) === controller) {
        activeStreams.current.delete(runId);
      }
      if (controller.signal.aborted) return;
      if (terminal) {
        terminalRunIds.current.add(runId);
        loadedTraceIds.current.add(runId);
        setRunTraces((current) => ({
          ...current,
          [runId]: {
            status: 'loaded',
            events: mergeChatFlowEvents(
              current[runId]?.events ?? [],
              accumulated,
            ),
          },
        }));
      }
      if (activeId) await loadHistory(activeId).catch(() => undefined);
      await loadWorkspace().catch(() => undefined);
    },
    [activeId, loadHistory, loadWorkspace, setError, tenantHeaders, workspace],
  );

  const loadRunTrace = useCallback(
    async (runId: string) => {
      if (
        !workspace ||
        loadedTraceIds.current.has(runId) ||
        traceLoads.current.has(runId)
      )
        return;
      traceLoads.current.add(runId);
      setRunTraces((current) => ({
        ...current,
        [runId]: { status: 'loading', events: current[runId]?.events ?? [] },
      }));
      try {
        const result = await readJson<{ events: ChatFlowEventEnvelope[] }>(
          await fetch(
            `/api/v1/runs/${runId}/events?workspaceId=${workspace.workspaceId}&format=json`,
            {
              cache: 'no-store',
              headers: { ...tenantHeaders, accept: 'application/json' },
            },
          ),
        );
        loadedTraceIds.current.add(runId);
        setRunTraces((current) => ({
          ...current,
          [runId]: {
            status: 'loaded',
            events: mergeChatFlowEvents(
              current[runId]?.events ?? [],
              result.events,
            ),
          },
        }));
      } catch {
        setRunTraces((current) => ({
          ...current,
          [runId]: { status: 'failed', events: [] },
        }));
      } finally {
        traceLoads.current.delete(runId);
      }
    },
    [tenantHeaders, workspace],
  );

  const recoverRun = useCallback(
    (runId: string) => {
      terminalRunIds.current.delete(runId);
      return streamRun(runId);
    },
    [streamRun],
  );

  useEffect(
    () => () => {
      for (const controller of activeStreams.current.values()) {
        controller.abort();
      }
      activeStreams.current.clear();
    },
    [],
  );

  return {
    loadRunTrace,
    recoverRun,
    resetRunState,
    runTraces,
    runViews,
    streamRun,
  };
}
