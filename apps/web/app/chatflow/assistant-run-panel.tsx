'use client';

import { useEffect, useRef, useState } from 'react';
import type { AssistantTreeView } from '@allrice/database';
import { presentAssistantTree } from '../../lib/chatflow/assistant-tree-presenter';
import { AssistantTreeCard } from './assistant-tree-card';

export function AssistantRunPanel({
  tree,
  workspaceId,
  headers,
  onArtifact,
  onChanged,
}: {
  tree: AssistantTreeView;
  workspaceId: string;
  headers: Record<string, string>;
  onArtifact: (id: string) => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<AssistantTreeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const requests = useRef(new Map<string, string>());
  const lifetime = useRef(0);
  const scope = `${workspaceId}/${tree.rootRunId}/${JSON.stringify(headers)}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const endpoint = `/api/v1/runtime/assistants?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(tree.rootRunId)}`;

  useEffect(() => {
    lifetime.current++;
    return () => {
      lifetime.current++;
    };
  }, [scope]);

  useEffect(() => {
    if (!expanded) return;
    // A long outage can exhaust the bounded retry loop. Reconnect re-reads
    // authority; it never replays a stop request or fabricates an ACK.
    const reconnect = () => setRevision((value) => value + 1);
    window.addEventListener('online', reconnect);
    return () => window.removeEventListener('online', reconnect);
  }, [expanded, scope]);

  useEffect(() => {
    if (!expanded) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    async function poll() {
      let live = true;
      try {
        const response = await fetch(endpoint, {
          headers,
          cache: 'no-store',
          signal: abort.signal,
        });
        if (!response.ok)
          throw new Error('助手明细暂不可用，请收起后重新展开。');
        const data = (await response.json()) as { tree: AssistantTreeView };
        if (abort.signal.aborted || currentScope.current !== scope) return;
        setDetail(data.tree);
        setError('');
        failures = 0;
        live = presentAssistantTree(data.tree).hasLiveWork;
      } catch (cause) {
        if (abort.signal.aborted || currentScope.current !== scope) return;
        setError(cause instanceof Error ? cause.message : '读取失败');
        failures++;
      }
      if (!abort.signal.aborted && live && failures < 3)
        timer = setTimeout(() => void poll(), failures ? 5000 : 2000);
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [expanded, endpoint, headers, scope, revision]);

  async function stop(childRunId?: string) {
    if (busy) return;
    const requestLifetime = lifetime.current;
    const current = () =>
      currentScope.current === scope && lifetime.current === requestLifetime;
    const requestKey = `${scope}/${childRunId ?? 'root'}`;
    let requestId = requests.current.get(requestKey);
    if (!requestId) {
      requestId = crypto.randomUUID();
      requests.current.set(requestKey, requestId);
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(
          childRunId
            ? { action: 'stop_child', requestId, childRunId }
            : { action: 'cancel_root', requestId },
        ),
      });
      if (!response.ok) throw new Error('停止请求未确认，请刷新状态后重试。');
      // Acceptance never changes the display to stopped. Re-read actual state.
      if (current()) {
        setRevision((item) => item + 1);
        onChanged();
      }
    } catch (cause) {
      if (current())
        setError(cause instanceof Error ? cause.message : '停止请求未确认');
    } finally {
      if (current()) setBusy(false);
    }
  }
  const current =
    expanded && detail?.rootRunId === tree.rootRunId ? detail : tree;
  return (
    <AssistantTreeCard
      tree={current}
      detailed={expanded && detail?.rootRunId === tree.rootRunId}
      busy={busy}
      error={error}
      onExpand={setExpanded}
      onStopChild={(id) => void stop(id)}
      onCancelRoot={() => void stop()}
      onArtifact={onArtifact}
    />
  );
}
