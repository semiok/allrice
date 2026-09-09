import type postgres from 'postgres';
import {
  EmployeeManifestSchema,
  McpEmployeeAuthorizationSchema,
  McpEmployeeBindingInputSchema,
  McpEmployeeTargetSchema,
  McpError,
  McpScopeSchema,
  UuidSchema,
  type FrozenMcpTool,
  type McpScope,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { createMcpStore } from './mcp-connections.ts';

type Database = ReturnType<typeof getDatabase>;
type Tx = postgres.TransactionSql;
type Version = {
  employee_id: string;
  version_id: string;
  name: string;
  version: number;
  manifest: unknown;
  status: string;
  assigned: boolean;
};
type Binding = {
  id: string;
  employee_id: string;
  employee_version_id: string;
  connector_binding_id: string;
  enabled: boolean;
  grant_revision: number;
};

/** Tenant grants only narrow an immutable pre-authorized policy. Explicit
 * denials are never removed and the published package is never rewritten. */
export function mcpEmployeeEligibility(
  manifest: unknown,
  transport: 'streamable_http' | 'local_stdio' = 'streamable_http',
): string[] {
  const parsed = EmployeeManifestSchema.safeParse(manifest);
  if (!parsed.success || parsed.data.schemaVersion !== 2)
    return ['需要发布新版员工策略'];
  const value = parsed.data,
    reasons: string[] = [];
  const requiredTools =
    transport === 'local_stdio'
      ? ['local.mcp.discover', 'local.mcp.call']
      : ['cloud.mcp.call'];
  for (const tool of requiredTools)
    if (!value.capabilityBindings.toolNames.includes(tool))
      reasons.push(`员工版本未声明 ${tool}`);
  const requiredCapabilities =
    transport === 'local_stdio'
      ? (['secret:use', 'storage:write'] as const)
      : (['secret:use', 'network:outbound'] as const);
  for (const capability of requiredCapabilities) {
    if (value.securityPolicy.deniedCapabilities.includes(capability))
      reasons.push(`员工策略明确禁止 ${capability}`);
    else if (!value.capabilities.includes(capability))
      reasons.push(`员工版本未许可 ${capability}`);
  }
  if (!value.securityPolicy.connectorIdentityModes.includes('service'))
    reasons.push('员工版本未许可 Service Connector 身份');
  if (value.securityPolicy.approvalPolicy === 'autonomous')
    reasons.push('MCP 必须逐次审批，不能使用自主执行策略');
  return reasons;
}

async function currentMember(
  tx: Database | Tx,
  scope: McpScope,
  admin: boolean,
) {
  const [row] = await tx`select m.id from allrice_memberships m
    join allrice_users u on u.id=m.user_id
    join allrice_organizations o on o.id=m.organization_id
    join allrice_workspaces w on w.id=${scope.workspaceId} and w.organization_id=o.id
    where m.organization_id=${scope.organizationId} and m.user_id=${scope.actorId}
      and m.active and m.role in ('admin','member') and (${admin}=false or m.role='admin')
      and (m.workspace_id is null or m.workspace_id=${scope.workspaceId})
      and u.status='active' and o.archived_at is null and w.archived_at is null
    for share of m,u,o,w`;
  if (!row) throw new McpError('MCP_DENIED');
}
function scopeFor(context: RequestContext, workspaceId: unknown) {
  if (context.actor.type !== 'user') throw new McpError('MCP_DENIED');
  return McpScopeSchema.parse({
    organizationId: context.organizationId,
    workspaceId: UuidSchema.parse(workspaceId),
    actorId: context.actor.id,
  });
}
function publicBinding(row: Binding) {
  return {
    id: row.id,
    revision: row.grant_revision,
    employeeId: row.employee_id,
    employeeVersionId: row.employee_version_id,
    connectionId: row.connector_binding_id,
    enabled: row.enabled,
  };
}
export function createEmployeeMcpBindingStore(
  options: {
    database?: Database;
    transport?: 'streamable_http' | 'local_stdio';
  } = {},
) {
  const db = () => options.database ?? getDatabase();
  const transport = options.transport ?? 'streamable_http';
  return {
    async list(context: RequestContext, workspaceId: string) {
      const scope = scopeFor(context, workspaceId);
      return db().begin(async (tx) => {
        await currentMember(tx, scope, true);
        const versions = await tx<
          Version[]
        >`select e.id as employee_id,v.id as version_id,v.name,v.version,v.manifest,e.status,
          exists(select 1 from allrice_employee_assignments a where a.employee_id=e.id and a.employee_version_id=v.id and a.organization_id=e.organization_id and a.workspace_id=e.workspace_id and a.active) as assigned
          from allrice_employees e join allrice_employee_versions v on v.employee_id=e.id and v.organization_id=e.organization_id and v.workspace_id=e.workspace_id
          where e.organization_id=${scope.organizationId} and e.workspace_id=${scope.workspaceId}
            and (exists(select 1 from allrice_employee_assignments a where a.employee_id=e.id and a.employee_version_id=v.id and a.active)
              or exists(select 1 from allrice_employee_mcp_bindings b where b.employee_version_id=v.id))
          order by e.name,v.version desc`;
        const bindings = await tx<
          Binding[]
        >`select b.* from allrice_employee_mcp_bindings b join allrice_mcp_binding_config c on c.binding_id=b.connector_binding_id where b.organization_id=${scope.organizationId} and b.workspace_id=${scope.workspaceId} and c.transport=${transport}
          and (${transport}<>'local_stdio' or exists(select 1 from allrice_local_mcp_config l where l.binding_id=b.connector_binding_id and l.owner_id=${scope.actorId}))`;
        return versions.map((v) => {
          const reasons = mcpEmployeeEligibility(v.manifest, transport);
          if (v.status !== 'active') reasons.push('员工已归档');
          if (!v.assigned) reasons.push('此版本已不再分配；只能撤销已有绑定');
          return McpEmployeeTargetSchema.parse({
            employeeId: v.employee_id,
            employeeVersionId: v.version_id,
            name: v.name,
            version: v.version,
            eligible: !reasons.length,
            reasons,
            bindings: bindings
              .filter((b) => b.employee_version_id === v.version_id)
              .map(publicBinding),
          });
        });
      });
    },
    async bind(context: RequestContext, input: unknown) {
      const change = McpEmployeeBindingInputSchema.parse(input),
        scope = scopeFor(context, change.workspaceId);
      return db().begin(async (tx) => {
        await currentMember(tx, scope, true);
        // Same employee-first lock order as publication and assignment updates.
        const [employee] =
          await tx`select id,status from allrice_employees where id=${change.employeeId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} for update`;
        if (!employee) throw new McpError('MCP_DENIED');
        const [version] =
          await tx`select id,manifest from allrice_employee_versions where id=${change.employeeVersionId} and employee_id=${change.employeeId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} for share`;
        if (!version) throw new McpError('MCP_DENIED');
        const [connection] =
          await tx`select b.id,b.enabled,d.enabled as definition_enabled from allrice_connector_bindings b join allrice_mcp_binding_config c on c.binding_id=b.id and c.organization_id=b.organization_id and c.workspace_id=b.workspace_id join allrice_connector_definitions d on d.id=b.connector_id and d.organization_id=b.organization_id and d.workspace_id=b.workspace_id where b.id=${change.connectionId} and b.organization_id=${scope.organizationId} and b.workspace_id=${scope.workspaceId} and c.transport=${transport} and b.identity_mode='service' for share of b,c,d`;
        if (!connection) throw new McpError('MCP_DENIED');
        if (transport === 'local_stdio') {
          const [owned] =
            await tx`select binding_id from allrice_local_mcp_config where binding_id=${change.connectionId} and owner_id=${scope.actorId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} for share`;
          if (!owned) throw new McpError('MCP_DENIED');
        }
        if (change.enabled) {
          const [assignment] =
            await tx`select id from allrice_employee_assignments where employee_id=${change.employeeId} and employee_version_id=${change.employeeVersionId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and active limit 1 for share`;
          if (
            employee.status !== 'active' ||
            !assignment ||
            !connection.enabled ||
            !connection.definition_enabled ||
            mcpEmployeeEligibility(version.manifest, transport).length
          )
            throw new McpError('MCP_DENIED');
        }
        const [previous] = await tx<
          Binding[]
        >`select * from allrice_employee_mcp_bindings where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and employee_id=${change.employeeId} and employee_version_id=${change.employeeVersionId} and connector_binding_id=${change.connectionId} for update`;
        if ((previous?.grant_revision ?? 0) !== change.expectedRevision)
          throw new McpError('MCP_BINDING_CHANGED');
        if (previous?.enabled === change.enabled)
          return publicBinding(previous);
        if (!previous && !change.enabled)
          throw new McpError('MCP_BINDING_CHANGED');
        const rows = previous
          ? await tx<
              Binding[]
            >`update allrice_employee_mcp_bindings set enabled=${change.enabled},grant_revision=grant_revision+1,granted_by=${scope.actorId},updated_at=clock_timestamp() where id=${previous.id} returning *`
          : await tx<
              Binding[]
            >`insert into allrice_employee_mcp_bindings(organization_id,workspace_id,employee_id,employee_version_id,connector_binding_id,enabled,granted_by) values(${scope.organizationId},${scope.workspaceId},${change.employeeId},${change.employeeVersionId},${change.connectionId},true,${scope.actorId}) returning *`;
        const row = rows[0]!;
        await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata) values(${scope.organizationId},${scope.workspaceId},${scope.actorId},'mcp.employee.binding','employee',${change.employeeId},'allowed','tenant_narrowed_pre_authorized_mcp_policy',${context.requestId},${tx.json({ bindingId: row.id, employeeVersionId: change.employeeVersionId, connectionId: change.connectionId, revision: row.grant_revision, enabled: row.enabled, scope: transport === 'local_stdio' ? 'local.mcp:device_owner:every_initialize_and_call' : 'cloud.mcp.call:connector_only:every_call' })})`;
        return publicBinding(row);
      });
    },
    async freeze(
      scopeInput: McpScope,
      employeeId: string,
      employeeVersionId: string,
    ): Promise<FrozenMcpTool[]> {
      if (transport !== 'streamable_http') throw new McpError('MCP_DENIED');
      const scope = McpScopeSchema.parse(scopeInput),
        eid = UuidSchema.parse(employeeId),
        vid = UuidSchema.parse(employeeVersionId);
      const authorizations = await db().begin(
        async (tx): Promise<Binding[]> => {
          await currentMember(tx, scope, false);
          const [version] =
            await tx`select v.manifest from allrice_employee_versions v join allrice_employees e on e.id=v.employee_id and e.organization_id=v.organization_id and e.workspace_id=v.workspace_id
          where v.id=${vid} and v.employee_id=${eid} and v.organization_id=${scope.organizationId} and v.workspace_id=${scope.workspaceId} and e.status='active' for share of e,v`;
          if (!version || mcpEmployeeEligibility(version.manifest).length)
            return [];
          const [assignment] =
            await tx`select id from allrice_employee_assignments where employee_id=${eid} and employee_version_id=${vid} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and user_id=${scope.actorId} and active for share`;
          if (!assignment) return [];
          const rows = await tx<
            Binding[]
          >`select * from allrice_employee_mcp_bindings where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and employee_id=${eid} and employee_version_id=${vid} and enabled for share`;
          return [...rows];
        },
      );
      if (!authorizations.length) return [];
      const tools = await createMcpStore({ database: db() }).freeze(
        scope,
        authorizations.map((a) => a.connector_binding_id),
      );
      return tools.flatMap((tool) => {
        const grant = authorizations.find(
          (a) => a.connector_binding_id === tool.connectionId,
        );
        return grant
          ? [
              {
                ...tool,
                employeeAuthorization: McpEmployeeAuthorizationSchema.parse({
                  id: grant.id,
                  revision: grant.grant_revision,
                  employeeId: grant.employee_id,
                  employeeVersionId: grant.employee_version_id,
                }),
              },
            ]
          : [];
      });
    },
  };
}

/** Used by every operation admission (including approval/start/lease checks).
 * A new grant revision cannot revive an older Run's frozen authorization. */
export async function assertEmployeeMcpAuthorization(
  tx: Database | Tx,
  scope: McpScope,
  tool: Pick<FrozenMcpTool, 'connectionId' | 'employeeAuthorization'>,
  employeeVersionId: string,
  transport: 'streamable_http' | 'local_stdio' = 'streamable_http',
) {
  const auth = tool.employeeAuthorization;
  if (!auth || auth.employeeVersionId !== employeeVersionId)
    throw new McpError('MCP_DENIED');
  // Acquire the employee lock before the grant lock, exactly as bind/revoke.
  // A multi-table FOR SHARE can otherwise lock the grant first and deadlock
  // with a concurrent revoke already holding the employee's FOR UPDATE lock.
  const [version] = await tx`select v.manifest from allrice_employees e
    join allrice_employee_versions v on v.employee_id=e.id and v.organization_id=e.organization_id and v.workspace_id=e.workspace_id
    where e.id=${auth.employeeId} and v.id=${employeeVersionId}
      and e.organization_id=${scope.organizationId} and e.workspace_id=${scope.workspaceId} and e.status='active'
    for share of e,v`;
  if (!version || mcpEmployeeEligibility(version.manifest, transport).length)
    throw new McpError('MCP_DENIED');
  const [row] = await tx`select b.id from allrice_employee_mcp_bindings b
    where b.id=${auth.id} and b.employee_id=${auth.employeeId} and b.employee_version_id=${employeeVersionId}
      and b.organization_id=${scope.organizationId} and b.workspace_id=${scope.workspaceId}
      and b.connector_binding_id=${tool.connectionId} and b.enabled and b.grant_revision=${auth.revision}
    for share of b`;
  if (!row) throw new McpError('MCP_DENIED');
}
