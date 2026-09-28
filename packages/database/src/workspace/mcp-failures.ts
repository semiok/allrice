import { classifyMcpFailure, type McpFailureKind } from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';

/** Called only after sessionRow authorizes history access. Derive historical
 * notices from immutable receipts without rewriting failed Runs or effects. */
export async function readSessionMcpFailures(
  organizationId: string,
  workspaceId: string,
  sessionId: string,
  ownerId: string,
  db = getDatabase(),
) {
  const rows = await db<
    {
      run_id: string;
      code: string | null;
      output: string | null;
      endpoint: string | null;
      tool: string | null;
      status: string;
    }[]
  >`
    select distinct on (r.id) r.id as run_id,
      a.result->'evidence'->>'code' as code,
      left(a.result->'evidence'->>'output', 20000) as output,
      c.endpoint, i.payload->'tool'->>'name' as tool,
      o.snapshot->>'status' as status
    from allrice_employee_runs er
    join allrice_runs r on r.id=er.run_id and r.organization_id=er.organization_id
      and r.workspace_id=er.workspace_id and r.owner_id=er.owner_id
    join allrice_runtime_operations o on o.root_run_id=r.id
      and o.organization_id=r.organization_id and o.workspace_id=r.workspace_id
    join allrice_mcp_execution_inputs i on i.operation_id=o.id
      and i.organization_id=o.organization_id and i.workspace_id=o.workspace_id and i.owner_id=r.owner_id
    left join allrice_mcp_execution_attempts a on a.operation_id=o.id
    left join allrice_mcp_binding_config c on c.binding_id=i.binding_id
      and c.organization_id=i.organization_id and c.workspace_id=i.workspace_id
    where er.organization_id=${organizationId} and er.workspace_id=${workspaceId}
      and er.session_id=${sessionId} and er.owner_id=${ownerId}
      and r.state='failed' and r.error_code='ASSISTANT_EXECUTION_UNRESOLVED'
      and o.snapshot->>'status'='unknown'
    order by r.id, (o.snapshot->>'status'='unknown') desc, o.created_at desc, o.id desc
  `;
  const notices = new Map<string, McpFailureKind>();
  for (const row of rows) {
    const kind = classifyMcpFailure({
      ...row,
      code: row.code ?? (row.status === 'unknown' ? 'MCP_UNKNOWN' : null),
    });
    if (kind) notices.set(row.run_id, kind);
  }
  return notices;
}
