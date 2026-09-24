import { randomUUID } from 'node:crypto';
import {
  McpError,
  type ExecutionContext,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { mcpEmployeeEligibility } from './mcp-employee-bindings.ts';

/** Resolve the human owner from the live Run. Neither model arguments nor a
 * claimed admin role can create a connection for someone else. */
export async function managedMcpRunContext(
  context: ExecutionContext,
  db = getDatabase(),
): Promise<RequestContext> {
  if (!context.workspaceId) throw new McpError('MCP_DENIED');
  const [run] = await db`select v.manifest from allrice_runs r
    join allrice_jobs j on j.run_id=r.id and j.id=${context.jobId} and j.worker_id=${context.worker.id}
    join allrice_employee_runs e on e.run_id=r.id and e.owner_id=r.owner_id
    join allrice_employee_versions v on v.id=e.employee_version_id
    join allrice_employees employee on employee.id=v.employee_id and employee.status='active'
    join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.user_id=r.owner_id and a.active
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.active_run_id=r.id and c.state='running'
    join allrice_policy_snapshots p on p.id=r.policy_snapshot_id and p.expires_at>clock_timestamp()
    where r.id=${context.runId} and r.organization_id=${context.organizationId} and r.workspace_id=${context.workspaceId}
      and r.owner_id=${context.policySnapshot.subjectId} and r.policy_snapshot_id=${context.policySnapshot.id}
      and r.state='running' and j.status='running' and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()
      and j.cancel_requested_at is null
      and e.execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' ? 'cloud.mcp.call'`;
  if (!run || mcpEmployeeEligibility(run.manifest).length)
    throw new McpError('MCP_DENIED');
  const memberships = await db<
    { id: string; workspace_id: string | null; role: 'admin' | 'member' }[]
  >`
    select m.id,m.workspace_id,m.role from allrice_memberships m join allrice_users u on u.id=m.user_id and u.status='active'
    join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=${context.workspaceId} and w.organization_id=o.id and w.archived_at is null
    where m.organization_id=${context.organizationId} and m.user_id=${context.policySnapshot.subjectId}
      and m.active and m.role in ('admin','member') and (m.workspace_id is null or m.workspace_id=${context.workspaceId})`;
  if (!memberships.length) throw new McpError('MCP_DENIED');
  return {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: { type: 'user', id: context.policySnapshot.subjectId },
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    authenticatedAt: new Date().toISOString(),
    memberships: memberships.map((m) => ({
      id: m.id,
      organizationId: context.organizationId,
      workspaceId: m.workspace_id,
      userId: context.policySnapshot.subjectId,
      active: true,
      role: m.role,
    })),
  };
}

export async function requestManagedMcpLogin(
  context: ExecutionContext,
  connectionId: string,
  db = getDatabase(),
) {
  const owner = await managedMcpRunContext(context, db);
  const [request] = await db<
    { id: string }[]
  >`insert into allrice_mcp_connection_requests(organization_id,workspace_id,run_id,binding_id,owner_id)
    select ${owner.organizationId},${owner.workspaceId!},${context.runId},c.binding_id,${owner.actor.id}
    from allrice_mcp_binding_config c where c.binding_id=${connectionId} and c.managed_by=${owner.actor.id}
      and c.organization_id=${owner.organizationId} and c.workspace_id=${owner.workspaceId!}
      and c.discovery_code='MCP_AUTH_REQUIRED'
    on conflict(run_id,binding_id) do update set answered_at=null returning id`;
  if (!request) throw new McpError('MCP_DENIED');
  return request.id;
}

/** Native question delivery is reused for live and parked tasks. Only a
 * server-issued connection request whose discovery succeeded can supply this
 * non-secret answer. It never approves a remote action. */
export async function resumeManagedMcpConnections(
  limit = 20,
  db = getDatabase(),
) {
  const [table] =
    await db`select to_regclass(format('%I.allrice_mcp_connection_requests',current_schema())) is not null as available`;
  if (!table?.available) return;
  const rows = await db<
    {
      id: string;
      run_id: string;
      organization_id: string;
      workspace_id: string;
      owner_id: string;
      session_id: string;
      thread_generation: number;
      active_turn_id: string;
      question_id: string;
    }[]
  >`
    select request.*,cr.session_id,cr.thread_generation,cr.active_turn_id,q.question_id
    from allrice_mcp_connection_requests request
    join allrice_mcp_binding_config c on c.binding_id=request.binding_id and c.managed_by=request.owner_id and c.discovery_state='ready'
    join allrice_connector_bindings b on b.id=c.binding_id and b.enabled
    join allrice_conversation_runtimes cr on cr.active_run_id=request.run_id and cr.state='running' and cr.owner_id=request.owner_id
    join allrice_runs r on r.id=request.run_id and r.state in ('running','waiting_approval')
    join allrice_task_questions q on q.run_id=request.run_id and q.pending
    where request.answered_at is null
      and not exists(select 1 from allrice_conversation_commands command where command.session_id=cr.session_id
        and command.expected_turn_id=cr.active_turn_id and command.expected_generation=cr.thread_generation and command.input_kind='ask_user' and command.state='pending')
      and not exists(select 1 from allrice_mcp_member_connections x where x.binding_id=c.binding_id and x.user_id=request.owner_id and not x.connected)
      and exists(select 1 from allrice_run_events e where e.run_id=request.run_id and e.event_type='harness.native'
        and e.payload->>'sourceEventType'='session/user-question' and e.payload->'nativePayload'->>'questionId'=q.question_id
        and e.payload->'nativePayload'->'questions'->0->>'id'='app-connect:'||request.id::text)
    order by request.created_at limit ${limit}`;
  for (const row of rows) {
    const memberships = await db<
      { id: string; workspace_id: string | null; role: 'admin' | 'member' }[]
    >`
      select id,workspace_id,role from allrice_memberships where organization_id=${row.organization_id} and user_id=${row.owner_id}
        and active and role in ('admin','member') and (workspace_id is null or workspace_id=${row.workspace_id})`;
    if (!memberships.length) continue;
    const context: RequestContext = {
      requestId: row.id,
      sessionId: row.id,
      actor: { type: 'user', id: row.owner_id },
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      authenticatedAt: new Date().toISOString(),
      memberships: memberships.map((m) => ({
        id: m.id,
        organizationId: row.organization_id,
        workspaceId: m.workspace_id,
        userId: row.owner_id,
        role: m.role,
        active: true,
      })),
    };
    try {
      const { sendChatMessage } = await import('./workspace/service.ts');
      await sendChatMessage(context, row.workspace_id, row.session_id, {
        clientMessageId: row.id,
        text: '应用已连接，继续当前任务。',
        deliveryMode: 'steer',
        expectedTurnId: row.active_turn_id,
        expectedGeneration: row.thread_generation,
        userQuestionAnswer: {
          questionId: row.question_id,
          answers: [
            { id: `app-connect:${row.id}`, selected: ['已连接，继续任务'] },
          ],
        },
      });
      await db`update allrice_mcp_connection_requests set answered_at=clock_timestamp() where id=${row.id}`;
    } catch {
      // A canceled/replaced turn is not resumed as a fresh task. A transient
      // database error can be retried with the same canonical input id.
    }
  }
}
