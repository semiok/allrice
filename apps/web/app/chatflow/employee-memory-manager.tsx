'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  employeeMemoryClient,
  MemoryAccessLost,
  MemoryClientError,
  memoryReadFailed,
  type MemoryList,
  type MemoryWriteStore,
} from '../../lib/memory/employee-memory-client';
import { EmployeeMemorySidebar } from './employee-memory-sidebar';

type Props = {
  scopeId: string;
  workspaceId: string;
  instanceId: string;
  headers: Record<string, string>;
  employeeName?: string;
  refreshKey?: string;
  active?: boolean;
  writes?: MemoryWriteStore;
};

/** The production owner host consumes only the complete schemaVersion2 API. */
export function EmployeeMemoryManager(props: Props) {
  const localWrites = useRef<MemoryWriteStore>(new Map());
  const credentials = JSON.stringify(Object.entries(props.headers).sort());
  const headers = useMemo(
    () => Object.fromEntries(JSON.parse(credentials)),
    [credentials],
  );
  return (
    <Manager
      key={`${props.scopeId}/${props.workspaceId}/${props.instanceId}/${credentials}`}
      {...props}
      headers={headers}
      writes={props.writes ?? localWrites.current}
    />
  );
}
function Manager(props: Props & { writes: MemoryWriteStore }) {
  const [page, setPage] = useState<MemoryList | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [accessRevision, setAccessRevision] = useState(0);
  const alive = useRef(true),
    generation = useRef(0);
  const source = useRef({});
  const client = useMemo(
    () => employeeMemoryClient(props, props.writes),
    [
      props.scopeId,
      props.workspaceId,
      props.instanceId,
      props.headers,
      props.writes,
    ],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
    };
  }, []);
  const clearPrivate = useCallback(() => {
    generation.current += 1;
    setPage(null);
    setLoading(false);
    setError(memoryReadFailed);
    setAccessRevision((value) => value + 1);
  }, []);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const started = ++generation.current;
      const current = () =>
        alive.current && !signal?.aborted && generation.current === started;
      setLoading(true);
      setError('');
      try {
        const value = await client.list(signal);
        if (current()) setPage(value);
      } catch (cause) {
        if (current()) {
          if (cause instanceof MemoryAccessLost) clearPrivate();
          else setError(memoryReadFailed);
        }
      } finally {
        if (current()) setLoading(false);
      }
    },
    [client, clearPrivate],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, props.refreshKey]);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.scopeId === props.scopeId && detail.source !== source.current)
        void load();
    };
    window.addEventListener('allrice:memory-changed', listener);
    return () => window.removeEventListener('allrice:memory-changed', listener);
  }, [load, props.scopeId]);
  async function changed(operation: Promise<unknown>) {
    try {
      await operation;
    } catch (cause) {
      // Only a verified 201/200/204 receipt resolves.
      if (alive.current && cause instanceof MemoryAccessLost) clearPrivate();
      else if (
        alive.current &&
        cause instanceof MemoryClientError &&
        ['memory_limit_reached', 'cas_conflict', 'contract_changed'].includes(
          cause.reason ?? '',
        )
      )
        await load();
      throw cause;
    }
    if (!alive.current) return;
    window.dispatchEvent(
      new CustomEvent('allrice:memory-changed', {
        detail: {
          scopeId: props.scopeId,
          workspaceId: props.workspaceId,
          instanceId: props.instanceId,
          source: source.current,
        },
      }),
    );
    // A failed read after acknowledged success is a read error, never a new write.
    if (alive.current) await load();
  }
  return (
    <div
      role="region"
      aria-label="个人记忆"
      style={{ height: '100%', minHeight: 0 }}
    >
      <EmployeeMemorySidebar
        targetKey={`${props.scopeId}/${props.workspaceId}/${props.instanceId}/${accessRevision}`}
        active={props.active}
        employeeName={props.employeeName ?? 'AI 员工'}
        rows={page ? [...page.pending, ...page.active] : []}
        loading={loading}
        error={error}
        onReload={() => void load()}
        onReadDetail={async (row, signal) => {
          try {
            return await client.detail(row, signal);
          } catch (cause) {
            if (
              alive.current &&
              !signal.aborted &&
              cause instanceof MemoryAccessLost
            )
              clearPrivate();
            throw cause;
          }
        }}
        onSave={(pair, row) => changed(client.save(pair, row))}
        onConfirm={(row) => changed(client.confirm(row))}
        onDelete={(row) => changed(client.remove(row))}
      />
    </div>
  );
}
