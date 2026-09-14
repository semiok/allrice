'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantTreeView } from '@allrice/database';
import { presentAssistantTree } from '../../lib/chatflow/assistant-tree-presenter';

export function useAssistantSession({
  enabled,
  sessionId,
  workspaceId,
  headers,
  runRevision,
  hasRunningRun,
}: {
  enabled: boolean;
  sessionId: string | null;
  workspaceId?: string;
  headers: Record<string, string>;
  runRevision: string;
  hasRunningRun: boolean;
}) {
  const scope = `${workspaceId}/${sessionId}/${JSON.stringify(headers)}`;
  const [value, setValue] = useState<{
    scope: string;
    trees: Record<string, AssistantTreeView>;
    nextCursor: string | null;
    paged: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{
    scope: string;
    text: string;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const load = useCallback(
    async (signal: AbortSignal, cursor?: string) => {
      if (!enabled || !sessionId || !workspaceId) return null;
      const requestGeneration = generation.current;
      const url = new URL('/api/v1/runtime/assistants', window.location.origin);
      url.searchParams.set('workspaceId', workspaceId);
      url.searchParams.set('sessionId', sessionId);
      if (cursor) url.searchParams.set('beforeRootRunId', cursor);
      const response = await fetch(url, { headers, signal, cache: 'no-store' });
      if (!response.ok)
        throw new Error(
          '助手任务记录暂不可用，请重试。不会据此判断任务已停止。',
        );
      const data = (await response.json()) as {
        trees: AssistantTreeView[];
        nextCursor: string | null;
      };
      if (!Array.isArray(data.trees)) throw new Error('助手任务记录格式异常');
      if (
        signal.aborted ||
        currentScope.current !== scope ||
        generation.current !== requestGeneration
      )
        return null;
      setValue((previous) => ({
        scope,
        trees: {
          ...(previous?.scope === scope ? previous.trees : {}),
          ...Object.fromEntries(
            data.trees.map((tree) => [tree.rootRunId, tree]),
          ),
        },
        nextCursor:
          cursor || !previous?.paged || previous.scope !== scope
            ? data.nextCursor
            : previous.nextCursor,
        paged: !!cursor || (previous?.scope === scope && previous.paged),
      }));
      setFailure(null);
      return data.trees;
    },
    [enabled, headers, scope, sessionId, workspaceId],
  );

  useEffect(() => {
    const abort = new AbortController();
    const currentGeneration = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    async function poll() {
      let live = hasRunningRun;
      try {
        const trees = await load(abort.signal);
        live ||= !!trees?.some(
          (tree) => presentAssistantTree(tree).hasLiveWork,
        );
        failures = 0;
      } catch (error) {
        if (!abort.signal.aborted && generation.current === currentGeneration) {
          setFailure({
            scope,
            text: error instanceof Error ? error.message : '助手记录暂不可用',
          });
          failures++;
        }
      }
      if (
        !abort.signal.aborted &&
        generation.current === currentGeneration &&
        (live || (failures > 0 && failures < 3))
      )
        timer = setTimeout(() => void poll(), failures ? 5000 : 2000);
    }
    if (enabled && sessionId && workspaceId) void poll();
    return () => {
      generation.current++;
      abort.abort();
      clearTimeout(timer);
    };
  }, [
    load,
    enabled,
    sessionId,
    workspaceId,
    runRevision,
    hasRunningRun,
    scope,
    revision,
  ]);

  const loadMore = async () => {
    const cursor = value?.scope === scope ? value.nextCursor : null;
    if (!cursor) return;
    try {
      await load(new AbortController().signal, cursor);
    } catch {
      if (currentScope.current === scope)
        setFailure({ scope, text: '历史助手任务加载失败，请重试。' });
    }
  };
  return {
    trees: value?.scope === scope ? value.trees : {},
    hasMore: value?.scope === scope && !!value.nextCursor,
    error: failure?.scope === scope ? failure.text : '',
    loadMore,
    reload: () => setRevision((item) => item + 1),
  };
}
