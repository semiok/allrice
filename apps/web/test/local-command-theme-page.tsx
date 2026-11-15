// Isolated current local-command and MCP panels; synthetic HTTP, no DB or device.
import { createRoot } from 'react-dom/client';
import { LocalCommandPanel } from '../app/chatflow/local-command-panel';
import { LocalMcpPanel } from '../app/chatflow/local-mcp-panel';
import { applyTheme } from '../lib/theme/theme';
import {
  id,
  workspace,
  operations,
  mcpOperations,
} from './local-command-theme-fixtures';
const pending = new Promise<Response>(() => {});
window.fetch = async (input, init) => {
  if (init?.method && init.method !== 'GET') return pending;
  const url = new URL(String(input), location.origin);
  if (url.pathname === '/api/v1/runtime/local-commands')
    return Response.json({ operations });
  if (url.pathname === '/api/v1/runtime/local-mcp')
    return Response.json({ operations: mcpOperations });
  return Response.json({}, { status: 404 });
};
const params = new URLSearchParams(location.search);
const theme = params.get('theme');
if (theme === 'light' || theme === 'dark') applyTheme(theme);
const headers = { 'x-test': 'synthetic' };
const surface = {
  minHeight: '100vh',
  background: 'var(--ar-surface)',
  color: 'var(--ar-text)',
};
const transcript = { ...surface, maxWidth: 760, margin: '0 auto', padding: 16 };
const views = {
  commands: (
    <div style={transcript}>
      <LocalCommandPanel
        runId={id(73)}
        workspaceId={workspace}
        tenantHeaders={headers}
        runActive={false}
      />
    </div>
  ),
  mcp: (
    <div style={transcript}>
      <LocalMcpPanel
        runId={id(73)}
        workspaceId={workspace}
        tenantHeaders={headers}
        runActive={false}
      />
    </div>
  ),
};
createRoot(document.getElementById('root')!).render(
  views[(params.get('view') ?? 'commands') as keyof typeof views],
);
