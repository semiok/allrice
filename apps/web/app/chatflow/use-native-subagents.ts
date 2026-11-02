'use client';
import { useEffect, useState } from 'react';
import {
  NativeSubagentSummarySchema,
  type NativeSubagentSummary,
} from '@allrice/contracts';
import { followNativeSubagents } from './native-subagent-follow';
import type { RunView } from './chatflow-types';

export const nativeSubagentReadyKey = (view?: RunView) =>
  view?.events.some(
    (event) =>
      event.runId === view.runId &&
      event.harness === 'dsh' &&
      event.type === 'harness.native' &&
      ['request/header', 'request/context'].includes(
        event.sourceEvent?.type ?? '',
      ),
  )
    ? view.runId
    : '';

export type NativeSubagentRead = NativeSubagentSummary | null | 'error';
export const nativeSubagentActivityUnknown = (
  read: NativeSubagentRead | undefined,
) =>
  read === null ||
  (typeof read === 'object' &&
    read.descendants.some(
      (entry) =>
        entry.parentId === read.rootId &&
        (entry.kind === 'diagnostic' || entry.running === null),
    ));

/** Read-only cuts and hot directory replacements share the same request owner. */
export function useNativeSubagents(
  workspaceId: string,
  headers: Record<string, string>,
  requests: Record<string, string>,
  liveOnly = false,
) {
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);
  const key = JSON.stringify([
    workspaceId,
    headers,
    requests,
    liveOnly,
    revision,
  ]);
  const [state, setState] = useState<{
    key: string;
    reads: Record<string, NativeSubagentRead>;
    disconnected?: Record<string, boolean>;
  }>({ key: '', reads: {} });
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    for (const event of ['focus', 'online', 'offline'])
      window.addEventListener(event, refresh);
    return () => {
      for (const event of ['focus', 'online', 'offline'])
        window.removeEventListener(event, refresh);
    };
  }, []);
  useEffect(() => {
    const [workspaceId, headers, requests, liveOnly] = JSON.parse(key);
    const abort = new AbortController();
    setState({ key, reads: {} });
    if (navigator.onLine !== false)
      void Promise.all(
        Object.keys(requests).map(async (id) => {
          let read: NativeSubagentRead = 'error';
          const publish = (read: NativeSubagentRead, disconnected = false) => {
            if (!abort.signal.aborted)
              setState((state) => ({
                key,
                reads: { ...state.reads, [id]: read },
                disconnected: { ...state.disconnected, [id]: disconnected },
              }));
          };
          try {
            const query = new URLSearchParams({ workspaceId });
            if (liveOnly) query.set('liveOnly', 'true');
            const response = await fetch(
              `/api/v1/sessions/${encodeURIComponent(id)}/subagents?${query}`,
              {
                headers,
                cache: 'no-store',
                signal: abort.signal,
              },
            );
            if (!response.ok) throw new Error('summary unavailable');
            const body = await response.json();
            read =
              liveOnly && body.summary === null
                ? null
                : NativeSubagentSummarySchema.parse(body.summary);
            publish(read);
            if (read?.root.source === 'live') {
              const rootId = read.rootId;
              const unavailable = new Error('directory unavailable');
              query.set('follow', 'true');
              await followNativeSubagents(
                `/api/v1/sessions/${encodeURIComponent(id)}/subagents?${query}`,
                headers,
                abort.signal,
                (event) => {
                  if (
                    event.type === 'directory' &&
                    event.summary.rootId === rootId
                  )
                    publish(event.summary);
                  else if (event.type === 'clear') {
                    publish(null);
                    if (event.reason === 'unavailable') throw unavailable;
                  } else throw new Error('directory scope changed');
                },
              ).catch((error) => {
                if (error !== unavailable) throw error;
              });
              if (abort.signal.aborted) return;
              publish(null);
              query.delete('follow');
              const response = await fetch(
                `/api/v1/sessions/${encodeURIComponent(id)}/subagents?${query}`,
                { headers, cache: 'no-store', signal: abort.signal },
              );
              if (!response.ok) throw new Error('summary unavailable');
              const body = await response.json();
              read =
                liveOnly && body.summary === null
                  ? null
                  : NativeSubagentSummarySchema.parse(body.summary);
              if (read && read.rootId !== rootId)
                throw new Error('directory scope changed');
              if (read?.root.source === 'live') {
                publish('error', true);
                return;
              }
            }
          } catch {
            read = 'error';
          }
          publish(read);
        }),
      );
    return () => abort.abort();
  }, [key]);
  return {
    reads: state.key === key ? state.reads : {},
    disconnected: state.key === key ? state.disconnected : undefined,
    refresh,
    revision,
  };
}
