'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  clearManualRunIntent,
  manualRunStorageKey,
  manualRunURL,
  parseManualRunIntent,
  resolveManualRunReceipt,
  saveManualRunIntent,
  type ManualRunIntent,
} from './manual-run-intent';
import { requestNotSent } from '../../lib/chatflow/automation-copy';
import { userFacingMessage } from '../../lib/chatflow/user-facing-error';

/** Explicit one-off action on the existing plan; restoring state grants GET only. */
export function AutomationManualRun(props: {
  scope: string;
  workspaceId: string;
  taskId: string;
  revision: number;
  available: boolean;
  headers: Record<string, string>;
  onChanged: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState<ManualRunIntent | null>(null),
    [key, setKey] = useState<string | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const live = useRef(true),
    writing = useRef(false),
    current = useRef<ManualRunIntent | null>(null);
  useEffect(() => {
    live.current = true;
    try {
      const storageKey = manualRunStorageKey(
          props.scope,
          props.workspaceId,
          props.taskId,
        ),
        raw = sessionStorage.getItem(storageKey);
      const intent = raw ? parseManualRunIntent(raw, storageKey) : null;
      setKey(storageKey);
      current.current = intent;
      setPending(intent);
      setReady(true);
      if (intent)
        setNotice(
          '上次立即执行的结果待确认，请点「检查立即执行结果」查看，不会重复执行。',
        );
    } catch (error) {
      setNotice(userFacingMessage(error, '暂时读不到上次立即执行的记录。'));
    }
    return () => {
      live.current = false;
    };
  }, [props.scope, props.workspaceId, props.taskId]);
  const request = async (readback: boolean) => {
    if (
      writing.current ||
      !ready ||
      !key ||
      (!readback && (!props.available || current.current))
    )
      return;
    const intent = readback
      ? current.current
      : {
          version: 1 as const,
          storageKey: key,
          workspaceId: props.workspaceId,
          taskId: props.taskId,
          request: {
            requestId: crypto.randomUUID(),
            expectedRevision: props.revision,
          },
        };
    if (!intent) return;
    writing.current = true;
    setBusy(true);
    let saved = readback;
    try {
      if (!readback) {
        saveManualRunIntent(sessionStorage, intent);
        saved = true;
        current.current = intent;
        setPending(intent);
      }
      const response = await fetch(
        manualRunURL(intent, readback),
        readback
          ? { headers: props.headers, cache: 'no-store' }
          : {
              method: 'POST',
              headers: { ...props.headers, 'content-type': 'application/json' },
              body: JSON.stringify(intent.request),
            },
      );
      const body: unknown = await response.json();
      if (!response.ok && ![403, 409].includes(response.status))
        throw new Error('立即执行的结果待确认。');
      const result = resolveManualRunReceipt(intent, body);
      if (
        !live.current ||
        current.current?.request.requestId !== intent.request.requestId
      )
        return;
      clearManualRunIntent(sessionStorage, intent);
      current.current = null;
      setPending(null);
      setNotice(
        result.kind === 'rejected'
          ? result.message
          : '已创建本次立即执行，可在运行记录查看结果。原定计划保持不变。',
      );
      await props.onChanged();
    } catch (error) {
      if (live.current) {
        if (!saved) setReady(false);
        setNotice(
          saved
            ? userFacingMessage(error, '立即执行的结果待确认。') +
                '可以点「检查立即执行结果」查看，不会自动重试。'
            : userFacingMessage(error, requestNotSent),
        );
      }
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <div>
      {notice && <p role="status">{notice}</p>}
      {pending ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void request(true)}
        >
          检查立即执行结果
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={!ready || busy || !props.available}
          onClick={() => void request(false)}
        >
          立即执行
        </Button>
      )}
    </div>
  );
}
