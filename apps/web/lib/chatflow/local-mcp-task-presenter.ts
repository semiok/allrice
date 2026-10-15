import type { ChatFlowEventEnvelope } from '@allrice/contracts';

const localMcpTools = new Set([
  'local.mcp.discover',
  'local.mcp.call',
  'local_mcp_discover',
  'local_mcp_call',
]);

export function hasLocalMcpEvents(events: ChatFlowEventEnvelope[]) {
  return events.some((event) => {
    if (event.type.startsWith('tool.'))
      return localMcpTools.has(String(event.payload.name));
    if (event.type !== 'harness.native') return false;
    return [
      event.payload.label,
      event.sourceEvent?.payload.name,
      event.sourceEvent?.payload.toolName,
    ].some((name) => localMcpTools.has(String(name)));
  });
}
