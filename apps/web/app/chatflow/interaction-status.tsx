'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  InteractionStatusSchema as schema,
  SessionRunTimingsSchema,
  type InteractionStatus,
} from '@allrice/contracts';
import { shortDateTime } from '../../lib/chatflow/browser-workspace-presenter';

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
          setError(
            workbenchEnabled
              ? '暂时读不到需要你确认的操作，会自动重试。'
              : '运行时间暂不可用',
          );
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
  onRetry,
}: {
  data: InteractionStatus | null;
  error: string;
  sessionId: string;
  onArtifact: (id: string) => void;
  onOperation?: (id: string) => void;
  /** Reads the state again at once; polling keeps retrying regardless. */
  onRetry?: () => void;
}) {
  if (!error && !data?.pendingActions.length) return null;
  return (
    <section>
      {error ? (
        <p role="status">
          <span>{error}</span>{' '}
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              刷新
            </Button>
          )}
        </p>
      ) : null}
      {data?.pendingActions.length ? (
        <section aria-label="等你确认的操作">
          <strong>等你确认的操作</strong>
          <ul>
            {data.pendingActions.map((a) => (
              <li key={a.approvalId}>
                {a.artifactId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onArtifact(a.artifactId!)}
                  >
                    查看并确认文件修改
                  </Button>
                ) : onOperation ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onOperation(a.operationId)}
                  >
                    查看并确认
                  </Button>
                ) : (
                  <a href={`?session=${sessionId}#operation-${a.operationId}`}>
                    查看并确认
                  </a>
                )}
                <small> · {shortDateTime(a.expiresAt)} 前有效</small>
              </li>
            ))}
          </ul>
          <p>
            请在对应的卡片里确认。在对话里回复或认可计划，不等于允许这些操作。
          </p>
        </section>
      ) : null}
    </section>
  );
}
