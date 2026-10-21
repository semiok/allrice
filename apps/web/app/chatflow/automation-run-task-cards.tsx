'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  AutomationCatalogHistorySchema,
  type AutomationCatalogTask,
} from '@allrice/contracts';
import { AutomationTaskCard } from './automation-tasks';

export function AutomationRunTaskCards({
  taskIds,
  workspaceId,
  headers,
  onOpen,
}: {
  taskIds: string[];
  workspaceId: string;
  headers: Record<string, string>;
  onOpen: (id: string) => void;
}) {
  const [tasks, setTasks] = useState<AutomationCatalogTask[]>([]);
  const ids = JSON.stringify(taskIds),
    credentials = JSON.stringify(
      Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
    );
  const stableHeaders = useMemo(
    () => Object.fromEntries(JSON.parse(credentials)),
    [credentials],
  );
  useEffect(() => {
    setTasks([]);
    const controller = new AbortController();
    void Promise.allSettled(
      (JSON.parse(ids) as string[]).map(async (id) => {
        const response = await fetch(
          '/api/v1/scheduled-tasks/' +
            encodeURIComponent(id) +
            '?workspaceId=' +
            encodeURIComponent(workspaceId),
          {
            headers: stableHeaders,
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error('Task unavailable');
        const { task } = AutomationCatalogHistorySchema.parse(
          await response.json(),
        );
        if (task.id !== id) throw new Error('Task identity changed');
        return task;
      }),
    ).then((results) => {
      if (!controller.signal.aborted)
        setTasks(
          results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])),
        );
    });
    return () => controller.abort();
  }, [ids, workspaceId, stableHeaders]);
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      {tasks.map((task) => (
        <AutomationTaskCard
          key={task.id}
          task={task}
          onOpen={() => onOpen(task.id)}
        />
      ))}
    </div>
  );
}
