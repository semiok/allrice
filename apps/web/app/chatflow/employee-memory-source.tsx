'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Button,
  DisclosureRow,
  IconInfoOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { MemorySourceViewProjection } from '@allrice/contracts';
import {
  memorySourceReadFailed,
  type MemorySourceRead,
} from '../../lib/memory/employee-memory-client';
import { memorySourceCopy } from '../../lib/memory/employee-memory-source-copy';
import css from './employee-memory-source.module.css';

type Props = {
  memoryId: string;
  active?: boolean;
  onRead: MemorySourceRead;
};
type Result =
  | { source: MemorySourceViewProjection; error?: never }
  | { error: true; source?: never };

/** This is a current-record projection, not a ticket to the original message
 * or a source snapshot pinned to the pair/revision displayed in the dialog. */
export function EmployeeMemorySource(props: Props) {
  return <Source key={props.memoryId} {...props} />;
}

function Source(props: Props) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setResult(null);
    if (!open || props.active === false) return;
    const current = new AbortController();
    controller.current = current;
    void (async () => {
      try {
        const source = await props.onRead(
          { id: props.memoryId },
          current.signal,
        );
        if (!current.signal.aborted) setResult({ source });
      } catch {
        if (!current.signal.aborted) setResult({ error: true });
      }
    })();
    return () => current.abort();
  }, [open, attempt, props.memoryId, props.active, props.onRead]);
  const source = result?.source;
  const copy = source ? memorySourceCopy(source) : null;
  return (
    <section className={css.source} aria-label="记忆来源">
      <DisclosureRow
        icon={<IconInfoOutlineRegular />}
        title="来源"
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => {
          controller.current?.abort();
          setResult(null);
          setOpen((value) => !value);
        }}
      >
        {result?.error ? (
          <p className={css.error} role="alert">
            {memorySourceReadFailed}{' '}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试
            </Button>
          </p>
        ) : source ? (
          <dl className={css.fields}>
            <div>
              <dt>来源类型</dt>
              <dd>{copy?.type}</dd>
            </div>
            <div>
              <dt>来源说明</dt>
              <dd>{copy?.label}</dd>
            </div>
            <div>
              <dt>记录于</dt>
              <dd>
                <time dateTime={source.capturedAt}>
                  {captureTime(source.capturedAt)}
                </time>
              </dd>
            </div>
          </dl>
        ) : (
          <p className={css.status} role="status">
            正在读取来源…
          </p>
        )}
      </DisclosureRow>
    </section>
  );
}

function captureTime(value: string) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
