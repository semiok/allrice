'use client';

import { useEffect, useMemo, useState } from 'react';
import { EmployeeMemoryListSchema } from '@allrice/contracts';
import { workbenchJson } from '../../lib/chatflow/workbench-model';
import { WorkbenchIcon } from './workbench-modules';
import css from './employee-memory-entry.module.css';

type Props = {
  scopeId: string;
  workspaceId: string;
  instanceId: string;
  headers: Record<string, string>;
  onOpen: (instanceId: string) => void;
};

/** Counts are owner-authorized totals, never a page length or a profile default. */
export function EmployeeMemoryEntry(props: Props) {
  return (
    <MemoryEntry
      key={`${props.scopeId}/${props.workspaceId}/${props.instanceId}`}
      {...props}
    />
  );
}

function MemoryEntry(props: Props) {
  const [counts, setCounts] = useState<{
    confirmed: number;
    pending: number;
  } | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const encodedHeaders = JSON.stringify(
    Object.entries(props.headers).sort(([a], [b]) => a.localeCompare(b)),
  );
  const headers = useMemo(
    () => Object.fromEntries(JSON.parse(encodedHeaders)),
    [encodedHeaders],
  );
  useEffect(() => {
    const controller = new AbortController();
    setCounts(null);
    setError(false);
    const query = new URLSearchParams({
      workspaceId: props.workspaceId,
      instanceId: props.instanceId,
    });
    void workbenchJson('/api/v1/memories/manage?' + query, headers, {
      cache: 'no-store', signal: controller.signal,
    })
      .then((raw) => {
        const page = EmployeeMemoryListSchema.parse(raw);
        if (page.workspaceId !== props.workspaceId || page.instanceId !== props.instanceId)
          throw Error('Memory count target changed');
        if (!controller.signal.aborted)
          setCounts({ confirmed: page.counts.active, pending: page.counts.pending });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [props.workspaceId, props.instanceId, headers, revision]);
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent).detail?.scopeId === props.scopeId)
        setRevision((value) => value + 1);
    };
    window.addEventListener('allrice:memory-changed', listener);
    return () => window.removeEventListener('allrice:memory-changed', listener);
  }, [props.scopeId]);

  return (
    <section className={css.row} aria-label="记忆">
      <span className={css.icon}>
        <WorkbenchIcon kind="experience" size={16} />
      </span>
      <span className={css.label}>记忆</span>
      <span className={css.summary} role={error ? 'alert' : 'status'}>
        {counts
          ? `${counts.confirmed} 条 · 待确认 ${counts.pending} 条`
          : error
            ? '记忆读取失败，请重试。'
            : '正在读取…'}
      </span>
      <span className={css.actions}>
        {error && (
          <button
            type="button"
            className={css.link}
            onClick={() => setRevision((value) => value + 1)}
          >
            重试
          </button>
        )}
        <button
          type="button"
          className={css.link}
          onClick={() => props.onOpen(props.instanceId)}
        >
          查看 <span aria-hidden="true">→</span>
        </button>
      </span>
    </section>
  );
}
