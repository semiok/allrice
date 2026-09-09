import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  CreateLocalMcpConnectionSchema,
  LocalMcpConfigurationSchema,
  LocalMcpConnectionSchema,
  FrozenLocalMcpConnectionSchema,
  LocalMcpSnapshotSchema,
  FrozenMcpToolSchema,
  McpGrantInputSchema,
  McpError,
  McpScopeSchema,
  UuidSchema,
  RuntimeLocalMcpPayloadSchema,
  RuntimeLocalMcpResultSchema,
  RuntimeOperationSnapshotSchema,
  assertMcpSchemaSubset,
  runtimeContractEqual,
  EmployeeExecutionSnapshotSchema,
  type RuntimeActionBinding,
  type RequestContext,
  type McpScope,
  type FrozenLocalMcpConnection,
  type LocalMcpSnapshot,
  type RuntimeLocalMcpPayload,
  type FrozenMcpTool,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { runtimePolicyDigest as digest } from './runtime-policy.ts';
import {
  mcpEmployeeEligibility,
  assertEmployeeMcpAuthorization,
} from './mcp-employee-bindings.ts';

type Database = ReturnType<typeof getDatabase>;
type Tx = postgres.TransactionSql;
type Row = {
  binding_id: string;
  name: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  device_id: string;
  device_name: string;
  folder_grant_id: string;
  folder_grant_version: number;
  configuration: unknown;
  revision: number;
  enabled: boolean;
  checked_at: Date | null;
  discovery_state: string;
  last_discovery_operation_id: string | null;
};
type ToolRow = {
  id: string;
  digest: string;
  definition: unknown;
  available: boolean;
  allowed: boolean;
  grant_revision: number;
  risk: FrozenMcpTool['risk'];
};
export const localMcpEnabled = () =>
  process.env.ALLRICE_LOCAL_MCP_ENABLED === '1' &&
  process.env.ALLRICE_LOCAL_COMMAND_ENABLED === '1' &&
  process.env.ALLRICE_RUNTIME_POLICY_ENABLED === '1' &&
  process.env.ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED === '1';

function scopeFor(
  context: Pick<RequestContext, 'actor' | 'organizationId'>,
  workspaceId: string,
): McpScope {
  if (context.actor.type !== 'user') throw new McpError('MCP_DENIED');
  return McpScopeSchema.parse({
    organizationId: context.organizationId,
    workspaceId,
    actorId: context.actor.id,
  });
}
async function member(tx: Database | Tx, scope: McpScope, admin: boolean) {
  const [row] =
    await tx`select m.id from allrice_memberships m join allrice_users u on u.id=m.user_id
    join allrice_organizations o on o.id=m.organization_id join allrice_workspaces w on w.id=${scope.workspaceId} and w.organization_id=o.id
    where m.organization_id=${scope.organizationId} and m.user_id=${scope.actorId} and m.active and m.role in ('admin','member')
      and (${admin}=false or m.role='admin') and (m.workspace_id is null or m.workspace_id=${scope.workspaceId})
      and u.status='active' and o.archived_at is null and w.archived_at is null for share of m,u,o,w`;
  if (!row) throw new McpError('MCP_DENIED');
}
async function read(
  tx: Database | Tx,
  scope: McpScope,
  id: string,
  lock = false,
) {
  const rows = await tx<
    Row[]
  >`select l.*,c.revision,c.discovery_state,c.checked_at,d.name,(b.enabled and d.enabled) as enabled,v.name as device_name
    from allrice_local_mcp_config l join allrice_mcp_binding_config c on c.binding_id=l.binding_id and c.transport='local_stdio'
    join allrice_connector_bindings b on b.id=l.binding_id join allrice_connector_definitions d on d.id=b.connector_id
    join allrice_bridge_devices v on v.id=l.device_id
    where l.binding_id=${UuidSchema.parse(id)} and l.organization_id=${scope.organizationId} and l.workspace_id=${scope.workspaceId} and l.owner_id=${scope.actorId}`;
  const row = rows[0];
  if (!row) throw new McpError('MCP_DENIED');
  if (lock) {
    await tx`select binding_id from allrice_mcp_binding_config where binding_id=${id} for share`;
    await tx`select binding_id from allrice_local_mcp_config where binding_id=${id} for share`;
    await tx`select id from allrice_connector_bindings where id=${id} for share`;
    return read(tx, scope, id, false);
  }
  return row;
}
async function tools(tx: Database | Tx, id: string) {
  return tx<
    ToolRow[]
  >`select r.id,r.digest,r.definition,g.available,g.allowed,g.grant_revision,g.risk from allrice_mcp_tool_grants g
    join allrice_mcp_tool_revisions r on r.id=g.revision_id and r.binding_id=g.binding_id where g.binding_id=${id} order by g.tool_name`;
}
function checkedConfiguration(value: unknown) {
  const cfg = LocalMcpConfigurationSchema.parse(value),
    { digest: claimed, ...source } = cfg.source;
  if (digest(source) !== claimed) throw new McpError('MCP_INVALID_SCHEMA');
  if (Buffer.byteLength(JSON.stringify(cfg)) > 32768)
    throw new McpError('MCP_LIMIT');
  return cfg;
}
async function audit(
  tx: Tx,
  scope: McpScope,
  id: string,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
    values(${scope.organizationId},${scope.workspaceId},${scope.actorId},${action},'connector_binding',${id},'recorded','explicit_local_mcp_governance',${tx.json(metadata as postgres.JSONValue)})`;
}
function frozenConnection(
  row: Row,
  auth: FrozenLocalMcpConnection['employeeAuthorization'],
) {
  return FrozenLocalMcpConnectionSchema.parse({
    connectionId: row.binding_id,
    connectionRevision: row.revision,
    deviceId: row.device_id,
    folderGrantId: row.folder_grant_id,
    folderGrantVersion: row.folder_grant_version,
    configuration: checkedConfiguration(row.configuration),
    employeeAuthorization: auth,
  });
}
export function localMcpCredentialReference(
  connection: Pick<FrozenLocalMcpConnection, 'connectionId' | 'configuration'>,
) {
  return (
    connection.configuration.credential?.id ??
    `local-mcp:${connection.connectionId}:none`
  );
}
async function currentDevice(
  tx: Database | Tx,
  scope: McpScope,
  deviceId: string,
  grantId: string,
) {
  const [row] = await tx<
    { runtime_generation: number }[]
  >`select f.runtime_generation from allrice_bridge_devices d join allrice_bridge_folder_grants f on f.device_id=d.id
    where d.id=${deviceId} and d.owner_id=${scope.actorId} and d.organization_id=${scope.organizationId} and d.workspace_id=${scope.workspaceId}
      and f.id=${grantId} and f.owner_id=d.owner_id and f.organization_id=d.organization_id and f.workspace_id=d.workspace_id
      and d.revoked_at is null and f.revoked_at is null for share of d,f`;
  if (!row) throw new McpError('MCP_DENIED');
  return row;
}

export function createLocalMcpStore(options: { database?: Database } = {}) {
  const db = () => options.database ?? getDatabase();
  async function view(scope: McpScope, id: string) {
    const row = await read(db(), scope, id);
    return LocalMcpConnectionSchema.parse({
      id: row.binding_id,
      name: row.name,
      workspaceId: row.workspace_id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      folderGrantId: row.folder_grant_id,
      folderGrantVersion: row.folder_grant_version,
      enabled: row.enabled,
      revision: row.revision,
      configuration: checkedConfiguration(row.configuration),
      discoveryState: row.discovery_state,
      checkedAt: row.checked_at?.toISOString() ?? null,
      credentialStorage: 'device_only',
      tools: (await tools(db(), id)).map((t) => ({
        ...(t.definition as object),
        revisionId: t.id,
        digest: t.digest,
        available: t.available,
        allowed: t.allowed,
        grantRevision: t.grant_revision,
        risk: t.risk,
      })),
    });
  }
  return {
    async create(context: RequestContext, input: unknown) {
      if (!localMcpEnabled()) throw new McpError('MCP_UNAVAILABLE');
      const args = CreateLocalMcpConnectionSchema.parse(input),
        scope = scopeFor(context, args.workspaceId),
        cfg = checkedConfiguration(args.configuration),
        id = randomUUID(),
        definition = randomUUID();
      await db().begin(async (tx) => {
        await tx`select id from allrice_workspaces where id=${scope.workspaceId} and organization_id=${scope.organizationId} for update`;
        await member(tx, scope, true);
        const grant = await currentDevice(
          tx,
          scope,
          args.deviceId,
          args.folderGrantId,
        );
        const [count] = await tx<
          { n: number }[]
        >`select count(*)::int as n from allrice_local_mcp_config l join allrice_connector_bindings b on b.id=l.binding_id where l.organization_id=${scope.organizationId} and l.workspace_id=${scope.workspaceId} and b.enabled`;
        if ((count?.n ?? 0) >= 16) throw new McpError('MCP_LIMIT');
        await tx`insert into allrice_connector_definitions(id,organization_id,workspace_id,connector_key,name,description,capabilities,input_schema,risk,identity_modes,resource_scopes,created_by)
          values(${definition},${scope.organizationId},${scope.workspaceId},${`local-mcp.${id}`},${args.name},'Device-scoped isolated MCP process',${tx.json(['storage:write', 'secret:use'])},'{}','write','["service"]','["workspace"]',${scope.actorId})`;
        await tx`insert into allrice_connector_bindings(id,organization_id,workspace_id,connector_id,identity_mode,user_id,credential_reference,resource_scope,created_by)
          values(${id},${scope.organizationId},${scope.workspaceId},${definition},'service',null,${cfg.credential?.id ?? `local-mcp:${id}:none`},${tx.json({ transport: 'local_stdio', deviceId: args.deviceId })},${scope.actorId})`;
        await tx`insert into allrice_mcp_binding_config(binding_id,organization_id,workspace_id,transport,endpoint,credential_envelope)
          values(${id},${scope.organizationId},${scope.workspaceId},'local_stdio',null,'null'::jsonb)`;
        await tx`insert into allrice_local_mcp_config(binding_id,organization_id,workspace_id,owner_id,device_id,folder_grant_id,folder_grant_version,configuration)
          values(${id},${scope.organizationId},${scope.workspaceId},${scope.actorId},${args.deviceId},${args.folderGrantId},${grant.runtime_generation},${tx.json(cfg)})`;
        await audit(tx, scope, id, 'local_mcp.register', {
          sourceDigest: cfg.source.digest,
          deviceId: args.deviceId,
        });
      });
      return view(scope, id);
    },
    async list(context: RequestContext, workspaceId: string) {
      const scope = scopeFor(context, workspaceId);
      await member(db(), scope, true);
      const rows = await db()<
        { binding_id: string }[]
      >`select binding_id from allrice_local_mcp_config where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.actorId} order by binding_id`;
      return Promise.all(rows.map((r) => view(scope, r.binding_id)));
    },
    async replace(
      context: RequestContext,
      input: {
        workspaceId: string;
        connectionId: string;
        expectedRevision: number;
        configuration?: unknown;
        revoke?: boolean;
      },
    ) {
      const scope = scopeFor(context, input.workspaceId);
      await db().begin(async (tx) => {
        await member(tx, scope, true);
        await tx`select binding_id from allrice_mcp_binding_config where binding_id=${input.connectionId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} for update`;
        const row = await read(tx, scope, input.connectionId);
        if (row.revision !== input.expectedRevision || !row.enabled)
          throw new McpError('MCP_BINDING_CHANGED');
        const cfg = checkedConfiguration(
          input.configuration ?? row.configuration,
        );
        if (!input.revoke)
          await currentDevice(tx, scope, row.device_id, row.folder_grant_id);
        await tx`update allrice_local_mcp_config set configuration=${tx.json(cfg)},last_discovery_operation_id=null where binding_id=${row.binding_id}`;
        await tx`update allrice_mcp_binding_config set revision=revision+1,discovery_state='idle',checked_at=null where binding_id=${row.binding_id}`;
        await tx`update allrice_connector_bindings set enabled=${!input.revoke},credential_reference=${cfg.credential?.id ?? `local-mcp:${row.binding_id}:none`},updated_at=clock_timestamp() where id=${row.binding_id}`;
        await tx`update allrice_mcp_tool_grants set available=false,allowed=false,grant_revision=grant_revision+1 where binding_id=${row.binding_id}`;
        await audit(
          tx,
          scope,
          row.binding_id,
          input.revoke ? 'local_mcp.revoke' : 'local_mcp.replace',
          { revision: row.revision + 1, sourceDigest: cfg.source.digest },
        );
      });
      return view(scope, input.connectionId);
    },
    async grant(context: RequestContext, input: unknown) {
      const args = McpGrantInputSchema.parse(input),
        scope = scopeFor(context, args.workspaceId);
      await db().begin(async (tx) => {
        await member(tx, scope, true);
        await tx`select binding_id from allrice_mcp_binding_config where binding_id=${args.connectionId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} for update`;
        const row = await read(tx, scope, args.connectionId);
        if (!row.enabled) throw new McpError('MCP_DENIED');
        const updated =
          await tx`update allrice_mcp_tool_grants set allowed=${args.allowed},risk=${args.risk},grant_revision=grant_revision+1,granted_by=${scope.actorId},updated_at=clock_timestamp() where binding_id=${row.binding_id} and revision_id=${args.revisionId} and available returning tool_name`;
        if (!updated.length) throw new McpError('MCP_DISCOVERY_STALE');
        await audit(tx, scope, row.binding_id, 'local_mcp.tool.grant', {
          revisionId: args.revisionId,
          allowed: args.allowed,
          risk: args.risk,
        });
      });
      return view(scope, args.connectionId);
    },
    async freeze(
      scopeInput: McpScope,
      employeeId: string,
      employeeVersionId: string,
    ): Promise<LocalMcpSnapshot> {
      const scope = McpScopeSchema.parse(scopeInput);
      return db().begin(async (tx) => {
        await member(tx, scope, false);
        const [version] =
          await tx`select v.manifest from allrice_employee_versions v join allrice_employees e on e.id=v.employee_id where v.id=${employeeVersionId} and e.id=${employeeId} and e.organization_id=${scope.organizationId} and e.workspace_id=${scope.workspaceId} and e.status='active' for share of e,v`;
        if (
          !version ||
          mcpEmployeeEligibility(version.manifest, 'local_stdio').length
        )
          return { connections: [], tools: [] };
        const [assigned] =
          await tx`select id from allrice_employee_assignments where employee_id=${employeeId} and employee_version_id=${employeeVersionId} and user_id=${scope.actorId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and active for share`;
        if (!assigned) return { connections: [], tools: [] };
        const bindings = await tx<
          { id: string; connector_binding_id: string; grant_revision: number }[]
        >`select b.id,b.connector_binding_id,b.grant_revision from allrice_employee_mcp_bindings b join allrice_local_mcp_config l on l.binding_id=b.connector_binding_id
          where b.organization_id=${scope.organizationId} and b.workspace_id=${scope.workspaceId} and b.employee_id=${employeeId} and b.employee_version_id=${employeeVersionId} and b.enabled and l.owner_id=${scope.actorId} for share of b`;
        const result: LocalMcpSnapshot = { connections: [], tools: [] };
        for (const binding of bindings) {
          const row = await read(tx, scope, binding.connector_binding_id, true);
          if (!row.enabled) continue;
          const grant = await currentDevice(
            tx,
            scope,
            row.device_id,
            row.folder_grant_id,
          ).catch((error) => {
            if (error instanceof McpError) return null;
            throw error;
          });
          if (!grant || grant.runtime_generation !== row.folder_grant_version)
            continue;
          const connection = frozenConnection(row, {
            id: binding.id,
            revision: binding.grant_revision,
            employeeId,
            employeeVersionId,
          });
          result.connections.push(connection);
          for (const tool of await tools(tx, row.binding_id))
            if (tool.allowed && tool.available)
              result.tools.push(
                FrozenMcpToolSchema.parse({
                  ...(tool.definition as object),
                  employeeAuthorization: connection.employeeAuthorization,
                  connectionId: row.binding_id,
                  connectionRevision: row.revision,
                  toolRevisionId: tool.id,
                  digest: tool.digest,
                  grantRevision: tool.grant_revision,
                  risk: tool.risk,
                  credentialReference: localMcpCredentialReference(connection),
                }),
              );
        }
        return LocalMcpSnapshotSchema.parse(result);
      });
    },
    /** Only a durable device receipt from a governed discovery operation may
     * populate the catalog. No browser-supplied tools/list is accepted. */
    async acceptDiscovery(operationId: string) {
      return db().begin(async (tx) => {
        const [op] = await tx<
          { snapshot: unknown; bridge_payload: unknown }[]
        >`select snapshot,bridge_payload from allrice_runtime_operations where id=${UuidSchema.parse(operationId)}`;
        if (!op) throw new McpError('MCP_DISCOVERY_STALE');
        const snapshot = RuntimeOperationSnapshotSchema.parse(op.snapshot),
          payload = RuntimeLocalMcpPayloadSchema.parse(op.bridge_payload);
        if (
          payload.capability !== 'local.mcp.discover' ||
          snapshot.status !== 'succeeded'
        )
          throw new McpError('MCP_DISCOVERY_STALE');
        const scope = McpScopeSchema.parse({
          organizationId: snapshot.binding.task.scope.organizationId,
          workspaceId: snapshot.binding.task.scope.workspaceId,
          actorId: snapshot.binding.requestedBy.id,
        });
        await member(tx, scope, false);
        await tx`select binding_id from allrice_mcp_binding_config where binding_id=${payload.arguments.connectionId} for update`;
        const row = await read(tx, scope, payload.arguments.connectionId);
        if (row.last_discovery_operation_id === operationId) return;
        // Configuration lock serializes catalog publication. A delayed older
        // discovery must never roll back the latest accepted catalog.
        if (row.last_discovery_operation_id) {
          const [newer] =
            await tx`select incoming.id from allrice_runtime_operations incoming
            join allrice_runtime_operations previous on previous.id=${row.last_discovery_operation_id}
            where incoming.id=${operationId} and (incoming.created_at,incoming.id)>(previous.created_at,previous.id)`;
          if (!newer) throw new McpError('MCP_DISCOVERY_STALE');
        }
        if (
          !row.enabled ||
          row.revision !== payload.arguments.connectionRevision ||
          !runtimeContractEqual(checkedConfiguration(row.configuration), {
            path: payload.arguments.path,
            source: payload.arguments.source,
            credential: payload.arguments.credential,
          })
        )
          throw new McpError('MCP_DISCOVERY_STALE');
        const [receipt] = await tx<
          { evidence: unknown }[]
        >`select payload->'evidence' as evidence from allrice_runtime_operation_receipts where operation_id=${operationId} and disposition='applied' and payload->'signal'->>'type'='operation.outcome' order by received_at desc limit 1`;
        const evidence = RuntimeLocalMcpResultSchema.parse(
          (receipt?.evidence as { output?: unknown })?.output,
        );
        if (
          !evidence.resultKnown ||
          !evidence.stopConfirmed ||
          !evidence.tools ||
          evidence.callAttempted ||
          evidence.reason !== 'completed'
        )
          throw new McpError('MCP_DISCOVERY_STALE');
        const names = evidence.tools.map((t) => t.name);
        if (new Set(names).size !== names.length)
          throw new McpError('MCP_INVALID_SCHEMA');
        for (const tool of evidence.tools) {
          assertMcpSchemaSubset(tool.inputSchema);
          if (tool.outputSchema) assertMcpSchemaSubset(tool.outputSchema);
        }
        await tx`update allrice_mcp_tool_grants set available=false,allowed=false,grant_revision=grant_revision+1 where binding_id=${row.binding_id} and available and not(tool_name=any(${tx.array(names)}))`;
        for (const tool of evidence.tools) {
          const toolDigest = digest(tool);
          await tx`insert into allrice_mcp_tool_revisions(organization_id,workspace_id,binding_id,tool_name,digest,definition) values(${scope.organizationId},${scope.workspaceId},${row.binding_id},${tool.name},${toolDigest},${tx.json(tool as postgres.JSONValue)}) on conflict(binding_id,tool_name,digest) do nothing`;
          const [revision] = await tx<
            { id: string }[]
          >`select id from allrice_mcp_tool_revisions where binding_id=${row.binding_id} and tool_name=${tool.name} and digest=${toolDigest}`;
          await tx`insert into allrice_mcp_tool_grants(organization_id,workspace_id,binding_id,tool_name,revision_id) values(${scope.organizationId},${scope.workspaceId},${row.binding_id},${tool.name},${revision!.id}) on conflict(binding_id,tool_name) do update set revision_id=excluded.revision_id,available=true,allowed=case when allrice_mcp_tool_grants.revision_id=excluded.revision_id and allrice_mcp_tool_grants.available then allrice_mcp_tool_grants.allowed else false end,grant_revision=allrice_mcp_tool_grants.grant_revision+case when allrice_mcp_tool_grants.revision_id<>excluded.revision_id or not allrice_mcp_tool_grants.available then 1 else 0 end,updated_at=clock_timestamp()`;
        }
        await tx`update allrice_local_mcp_config set last_discovery_operation_id=${operationId} where binding_id=${row.binding_id}`;
        await tx`update allrice_mcp_binding_config set discovery_state='ready',checked_at=clock_timestamp() where binding_id=${row.binding_id}`;
        await audit(tx, scope, row.binding_id, 'local_mcp.discovery.received', {
          operationId,
          toolCount: evidence.tools.length,
        });
      });
    },
  };
}

/** Called on approval, START and every renewed short lease, not only at freeze. */
export async function assertLocalMcpAuthority(
  tx: Database | Tx,
  scope: McpScope,
  frozen: FrozenLocalMcpConnection,
  payload: RuntimeLocalMcpPayload,
  employeeVersionId: string,
) {
  if (!localMcpEnabled()) throw new McpError('MCP_DENIED');
  await assertEmployeeMcpAuthorization(
    tx,
    scope,
    {
      connectionId: frozen.connectionId,
      employeeAuthorization: frozen.employeeAuthorization,
    },
    employeeVersionId,
    'local_stdio',
  );
  const row = await read(tx, scope, frozen.connectionId, true);
  if (
    !row.enabled ||
    !runtimeContractEqual(
      frozenConnection(row, frozen.employeeAuthorization),
      frozen,
    ) ||
    payload.arguments.connectionRevision !== frozen.connectionRevision ||
    payload.arguments.deviceId !== frozen.deviceId ||
    !runtimeContractEqual(
      {
        path: payload.arguments.path,
        source: payload.arguments.source,
        credential: payload.arguments.credential,
      },
      frozen.configuration,
    )
  )
    throw new McpError('MCP_DENIED');
  if (payload.capability === 'local.mcp.call') {
    const tool = payload.arguments.tool,
      entries = await tools(tx, row.binding_id),
      entry = entries.find((t) => t.id === tool.toolRevisionId);
    if (
      !entry?.available ||
      !entry.allowed ||
      entry.grant_revision !== tool.grantRevision ||
      entry.risk !== tool.risk ||
      entry.digest !== tool.digest ||
      digest(entry.definition) !== tool.digest ||
      tool.credentialReference !== localMcpCredentialReference(frozen) ||
      !runtimeContractEqual(
        tool.employeeAuthorization,
        frozen.employeeAuthorization,
      )
    )
      throw new McpError('MCP_DENIED');
    if (
      digest({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }) !== tool.digest
    )
      throw new McpError('MCP_DENIED');
  }
}

/** Approval rechecks the immutable, already stored operation, not a browser-
 * supplied catalog. Creation is checked by the governed Bridge resolver;
 * dispatch/START/renewal continue to perform that full check independently. */
export async function assertLocalMcpApprovalAuthority(
  tx: Database | Tx,
  scope: McpScope,
  binding: RuntimeActionBinding,
) {
  const [row] = await tx<
    {
      snapshot: unknown;
      bridge_payload: unknown;
      execution_snapshot: unknown;
    }[]
  >`
    select o.snapshot,o.bridge_payload,e.execution_snapshot from allrice_runtime_operations o
    join allrice_employee_runs e on e.run_id=o.run_id and e.organization_id=o.organization_id and e.workspace_id=o.workspace_id and e.owner_id=${scope.actorId}
    join allrice_conversation_runtimes c on c.session_id=e.session_id and c.organization_id=e.organization_id and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id
    join allrice_jobs j on j.run_id=e.run_id and j.organization_id=e.organization_id and j.workspace_id=e.workspace_id and j.owner_id=e.owner_id
    join allrice_employee_assignments a on a.id=e.employee_assignment_id and a.organization_id=e.organization_id and a.workspace_id=e.workspace_id and a.user_id=e.owner_id
    where o.id=${binding.attempt.operationId} and o.run_id=${binding.task.runId} and o.organization_id=${scope.organizationId} and o.workspace_id=${scope.workspaceId}
      and c.active_run_id=e.run_id and c.state='running' and c.thread_generation=${binding.attempt.generation}
      and j.status='running' and j.worker_id=c.worker_id and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() and j.cancel_requested_at is null
      and a.active and a.employee_version_id=e.employee_version_id
    for share of e,c,j,a`;
  if (!row) throw new McpError('MCP_DENIED');
  const stored = RuntimeOperationSnapshotSchema.parse(row.snapshot),
    payload = RuntimeLocalMcpPayloadSchema.parse(row.bridge_payload),
    frozen = EmployeeExecutionSnapshotSchema.parse(row.execution_snapshot);
  if (
    !runtimeContractEqual(stored.binding, binding) ||
    frozen.schemaVersion !== 2 ||
    !frozen.capabilitySnapshot.bindings.toolNames.includes(
      payload.capability,
    ) ||
    !['storage:write', 'secret:use'].every((capability) =>
      frozen.capabilitySnapshot.grantedCapabilities.includes(
        capability as 'storage:write' | 'secret:use',
      ),
    )
  )
    throw new McpError('MCP_DENIED');
  const connection = frozen.localMcp?.connections.find(
    (c) => c.connectionId === payload.arguments.connectionId,
  );
  if (
    !connection ||
    (payload.capability === 'local.mcp.call' &&
      !frozen.localMcp?.tools.some((t) =>
        runtimeContractEqual(t, payload.arguments.tool),
      ))
  )
    throw new McpError('MCP_DENIED');
  await assertLocalMcpAuthority(
    tx,
    scope,
    connection,
    payload,
    binding.task.frozenConfiguration.employeeVersionId!,
  );
}
