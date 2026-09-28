import type { McpConnection } from '@allrice/contracts';

/** Shared by the connection manager and capability overview. */
export function connectionStatusLabel(connection: McpConnection) {
  if (connection.disconnected || !connection.enabled) return '已断开';
  if (connection.discoveryState === 'ready') return '已连接';
  if (connection.discoveryCode === 'MCP_AUTH_REQUIRED') return '需要登录';
  if (['queued', 'running'].includes(connection.discoveryState))
    return '正在连接';
  return '连接未完成';
}

export function visibleConnection(connection: McpConnection) {
  return !connection.removed && (connection.enabled || !connection.shared);
}
