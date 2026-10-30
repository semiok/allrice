'use client';
import { useEffect, useState } from 'react';
import {
  NativeSubagentSummarySchema,
  type NativeSubagentSummary,
} from '@allrice/contracts';

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

/** Read-only cuts, invalidated on scope/lifecycle changes; C3 owns live updates. */
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
          } catch {
            /* Failed reads remain visible, never an empty catalog. */
          }
          if (!abort.signal.aborted)
            setState((state) => ({
              key,
              reads: { ...state.reads, [id]: read },
            }));
        }),
      );
    return () => abort.abort();
  }, [key]);
  return { reads: state.key === key ? state.reads : {}, refresh };
}
