'use client';

import { useEffect, useState } from 'react';
import { McpConnectionSchema, type McpConnection } from '@allrice/contracts';
import {
  connectionStatusLabel,
  visibleConnection,
} from '../../lib/connection-status';
import styles from './capability-panel.module.css';

/** Read the same member-scoped source as Settings → Connected apps. */
export function OnlineAppConnections({
  workspaceId,
  organizationId,
  refreshKey,
}: {
  workspaceId: string;
  organizationId: string;
  refreshKey: string;
}) {
  const [connections, setConnections] = useState<McpConnection[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    let active = true;
    setConnections(null);
    setFailed(false);
    void (async () => {
      try {
        const response = await fetch(
          `/api/v1/connections?workspaceId=${encodeURIComponent(workspaceId)}`,
          {
            cache: 'no-store',
            signal: controller.signal,
            headers: {
              'x-allrice-organization-id': organizationId,
              'x-allrice-workspace-id': workspaceId,
            },
          },
        );
        if (!response.ok) throw Error('connection_status_unavailable');
        const body = await response.json();
        const list = McpConnectionSchema.array().parse(body.connections);
        if (list.some((connection) => connection.workspaceId !== workspaceId))
          throw Error('connection_scope_mismatch');
        if (active && !controller.signal.aborted)
          setConnections(list.filter(visibleConnection));
      } catch {
        if (active) setFailed(true);
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [workspaceId, organizationId, refreshKey]);

  if (failed)
    return (
      <p role="status">
        连接状态暂时无法读取，请刷新能力状态或查看“已连接应用”。
      </p>
    );
  if (connections === null) return <p role="status">正在同步应用连接…</p>;
  if (!connections.length)
    return <p>尚未添加在线应用，可在“已连接应用”中连接。</p>;
  return (
    <ul className={styles.connections} aria-label="在线应用连接状态">
      {connections.map((connection) => (
        <li key={connection.id}>
          <span>{connection.name}</span>
          <span>{connectionStatusLabel(connection)}</span>
        </li>
      ))}
    </ul>
  );
}
