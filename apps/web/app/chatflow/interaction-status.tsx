'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import {
  InteractionStatusSchema as schema,
  SessionRunTimingsSchema,
  type InteractionStatus,
} from '@allrice/contracts';

export function useInteractionStatus(
  workbenchEnabled: boolean,
  sessionId: string | null,
  workspaceId: string | undefined,
  headers: Record<string, string>,
) {
  const [value, setValue] = useState<{
      scope: string;
      data: InteractionStatus;
    } | null>(null),
    [error, setError] = useState('');
  const scope = `${workspaceId}/${sessionId}`;
  const generation = useRef(0);
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!sessionId || !workspaceId) return;
      const requestGeneration = ++generation.current;
      try {
        const response = await fetch(
          `/api/v1/sessions/${sessionId}/${workbenchEnabled ? 'interactions' : 'timings'}?workspaceId=${workspaceId}`,
          { headers, cache: 'no-store', signal },
        );
        if (!response.ok) throw new Error('交互状态暂不可用');
        const body = await response.json();
        const data = workbenchEnabled
          ? schema.parse(body)
          : {
              ...SessionRunTimingsSchema.parse(body),
              runtime: null,
              inputs: [],
              pendingActions: [],
            };
        if (!signal?.aborted && requestGeneration === generation.current) {
          setValue({ scope, data });
          setError('');
        }
      } catch {
        if (!signal?.aborted && requestGeneration === generation.current) {
          setValue(null);
          setError(workbenchEnabled ? '交互状态暂不可用' : '运行时间暂不可用');
        }
      }
    },
    [workbenchEnabled, sessionId, workspaceId, headers, scope],
  );
  useEffect(() => {
    const abort = new AbortController();
    void reload(abort.signal);
    const timer = setInterval(() => void reload(abort.signal), 2000);
    return () => {
      generation.current++;
      abort.abort();
      clearInterval(timer);
    };
  }, [reload]);
  return { data: value?.scope === scope ? value.data : null, error, reload };
}
export function InteractionStatusPanel({
  data,
  error,
  sessionId,
  onArtifact,
  onOperation,
}: {
  data: InteractionStatus | null;
  error: string;
  sessionId: string;
  onArtifact: (id: string) => void;
  onOperation?: (id: string) => void;
}) {
  if (!error && !data?.pendingActions.length) return null;
  return (
    <section>
      {error ? <p role="status">{error}</p> : null}
      {data?.pendingActions.length ? (
        <section aria-label="待批准动作">
          <strong>待批准动作</strong>
          <ul>
            {data.pendingActions.map((a) => (
              <li key={a.approvalId}>
                {a.artifactId ? (
                  <button
                    type="button"
                    onClick={() => onArtifact(a.artifactId!)}
                  >
                    审查文件操作与批准／拒绝
                  </button>
                ) : onOperation ? (
                  <button
                    type="button"
                    onClick={() => onOperation(a.operationId)}
                  >
                    查看精确动作与批准／拒绝
                  </button>
                ) : (
                  <a href={`?session=${sessionId}#operation-${a.operationId}`}>
                    查看精确动作与批准／拒绝
                  </a>
                )}
                <small>
                  {' '}
                  · {new Date(a.expiresAt).toLocaleTimeString()} 前有效
                </small>
              </li>
            ))}
          </ul>
          <p>只在对应动作卡片批准，不会通过聊天或计划认可代替授权。</p>
        </section>
      ) : null}
    </section>
  );
}
