import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { z } from 'zod';
import type postgres from 'postgres';
import {
  CreateMcpConnectionInputSchema,
  FrozenMcpToolSchema,
  McpBearerSchema,
  McpConnectionSchema,
  McpDiscoveredToolSchema,
  McpError,
  McpGrantInputSchema,
  McpScopeSchema,
  UuidSchema,
  type FrozenMcpTool,
  type McpDiscoveredTool,
  type McpScope,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { connectorInputDigest } from './capabilities/connector-broker.ts';

type Database = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;
type ConnectionRow = {
  id: string;
  definition_id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  endpoint: string;
  revision: number;
  enabled: boolean;
  credential_reference: string;
  credential_envelope: unknown;
  discovery_state: 'idle' | 'queued' | 'running' | 'ready' | 'error';
  discovery_code: string | null;
  checked_at: Date | null;
};
type ToolRow = {
  id: string;
  digest: string;
  definition: McpDiscoveredTool;
  available: boolean;
  allowed: boolean;
  grant_revision: number;
  risk: FrozenMcpTool['risk'];
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const envelopeSchema = z
  .object({
    iv: z.string().regex(/^[a-f0-9]{24}$/),
    tag: z.string().regex(/^[a-f0-9]{32}$/),
    ciphertext: z
      .string()
      .regex(/^[a-f0-9]+$/)
      .max(8192),
  })
  .strict();
function adminScope(context: RequestContext, workspaceInput: string): McpScope {
  const workspaceId = UuidSchema.parse(workspaceInput);
  if (
    context.actor.type !== 'user' ||
    !context.memberships.some(
      (m) =>
        m.active &&
        m.userId === context.actor.id &&
        m.organizationId === context.organizationId &&
        (m.workspaceId === null || m.workspaceId === workspaceId) &&
        m.role === 'admin',
    )
  )
    throw new McpError('MCP_DENIED');
  return McpScopeSchema.parse({
    organizationId: context.organizationId,
    workspaceId,
    actorId: context.actor.id,
  });
}
function encryptionKey(value: string | undefined) {
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    throw new McpError('MCP_CREDENTIAL_UNAVAILABLE');
  return Buffer.from(value, 'hex');
}
async function currentAdmin(tx: Database | Tx, scope: McpScope) {
  const [row] =
    await tx`select m.id from allrice_memberships m join allrice_users u on u.id=m.user_id
    join allrice_organizations o on o.id=m.organization_id join allrice_workspaces w on w.id=${scope.workspaceId} and w.organization_id=o.id
    where m.organization_id=${scope.organizationId} and m.user_id=${scope.actorId} and m.active and m.role='admin'
    and (m.workspace_id is null or m.workspace_id=${scope.workspaceId}) and u.status='active' and o.archived_at is null and w.archived_at is null
    for share of m,u,o,w`;
  if (!row) throw new McpError('MCP_DENIED');
}
function aad(scope: McpScope, bindingId: string, revision: number) {
  return Buffer.from(
    `${scope.organizationId}:${scope.workspaceId}:${bindingId}:${revision}`,
  );
}
function seal(value: string, key: Buffer, associated: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associated);
  return {
    iv: iv.toString('hex'),
    ciphertext: Buffer.concat([
      cipher.update(McpBearerSchema.parse(value)),
      cipher.final(),
    ]).toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}
function unseal(value: unknown, key: Buffer, associated: Buffer) {
  try {
    const envelope = envelopeSchema.parse(value);
    const cipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'hex'),
    );
    cipher.setAAD(associated);
    cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    return McpBearerSchema.parse(
      Buffer.concat([
        cipher.update(Buffer.from(envelope.ciphertext, 'hex')),
        cipher.final(),
      ]).toString('utf8'),
    );
  } catch {
    throw new McpError('MCP_CREDENTIAL_UNAVAILABLE');
  }
}
async function audit(
  tx: Tx,
  scope: McpScope,
  bindingId: string,
  action: string,
  metadata: Record<string, string | number | boolean> = {},
) {
  await tx`insert into allrice_audit_events (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata) values (${scope.organizationId},${scope.workspaceId},${scope.actorId},${action},'connector_binding',${bindingId},'recorded','tenant_mcp_governance',${tx.json(metadata)})`;
}

export interface McpDiscoveryLease {
  connectionId: string;
  revision: number;
  token: string;
  scope: McpScope;
  endpoint: string;
  credentialReference: string;
}
/** No call execution claim is provided here. Runtime policy + operation ledger
 * own approval, dispatch and uncertainty. This adapter only authenticates the
 * frozen connector/tool authorization immediately before network access. */
export function createMcpStore(
  options: { database?: Database; credentialKey?: string } = {},
) {
  const db = () => options.database ?? getDatabase();
  const key = () =>
    encryptionKey(
      options.credentialKey ?? process.env.ALLRICE_MCP_CREDENTIAL_KEY,
    );
  async function read(
    scope: McpScope,
    bindingId: string,
    tx: Database | Tx = db(),
  ) {
    const [row] = await tx<
      ConnectionRow[]
    >`select b.id,b.connector_id as definition_id,b.organization_id,b.workspace_id,d.name,c.endpoint,c.revision,(b.enabled and d.enabled) as enabled,b.credential_reference,c.credential_envelope,c.discovery_state,c.discovery_code,c.checked_at from allrice_mcp_binding_config c join allrice_connector_bindings b on b.id=c.binding_id join allrice_connector_definitions d on d.id=b.connector_id where c.transport='streamable_http' and b.id=${UuidSchema.parse(bindingId)} and b.organization_id=${scope.organizationId} and b.workspace_id=${scope.workspaceId}`;
    if (!row) throw new McpError('MCP_DENIED');
    return row;
  }
  async function tools(
    scope: McpScope,
    bindingId: string,
    tx: Database | Tx = db(),
  ) {
    return tx<
      ToolRow[]
    >`select r.id,r.digest,r.definition,g.available,g.allowed,g.grant_revision,g.risk from allrice_mcp_tool_grants g join allrice_mcp_tool_revisions r on r.id=g.revision_id where g.binding_id=${bindingId} and g.organization_id=${scope.organizationId} and g.workspace_id=${scope.workspaceId} order by g.tool_name`;
  }
  async function lockConnection(scope: McpScope, bindingId: string, tx: Tx) {
    const [row] =
      await tx`select binding_id from allrice_mcp_binding_config where binding_id=${UuidSchema.parse(bindingId)} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} for update`;
    if (!row) throw new McpError('MCP_DENIED');
  }
  async function publicConnection(scope: McpScope, bindingId: string) {
    const row = await read(scope, bindingId);
    const entries = await tools(scope, bindingId);
    return McpConnectionSchema.parse({
      id: row.id,
      definitionId: row.definition_id,
      workspaceId: row.workspace_id,
      name: row.name,
      endpoint: row.endpoint,
      enabled: row.enabled,
      revision: row.revision,
      credentialConfigured: true,
      credentialReference: row.credential_reference,
      discoveryState: row.discovery_state,
      discoveryCode: row.discovery_code,
      checkedAt: row.checked_at?.toISOString() ?? null,
      tools: entries.map((t) => ({
        ...t.definition,
        revisionId: t.id,
        digest: t.digest,
        available: t.available,
        allowed: t.allowed,
        grantRevision: t.grant_revision,
        risk: t.risk,
      })),
    });
  }
  async function assertAuthorized(
    scopeInput: McpScope,
    frozenInput: FrozenMcpTool,
  ) {
    const scope = McpScopeSchema.parse(scopeInput);
    const frozen = FrozenMcpToolSchema.parse(frozenInput);
    const connection = await read(scope, frozen.connectionId);
    const current = (await tools(scope, frozen.connectionId)).find(
      (t) => t.id === frozen.toolRevisionId,
    );
    const declared = {
      name: frozen.name,
      description: frozen.description,
      inputSchema: frozen.inputSchema,
      outputSchema: frozen.outputSchema,
    };
    if (
      !connection.enabled ||
      connection.revision !== frozen.connectionRevision ||
      connection.credential_reference !== frozen.credentialReference ||
      !current?.available ||
      !current.allowed ||
      current.grant_revision !== frozen.grantRevision ||
      current.risk !== frozen.risk ||
      current.digest !== frozen.digest ||
      connectorInputDigest(current.definition) !== frozen.digest ||
      connectorInputDigest(declared) !== frozen.digest
    )
      throw new McpError('MCP_DENIED');
    return {
      endpoint: connection.endpoint,
      credentialReference: connection.credential_reference,
    };
  }
  return {
    async create(context: RequestContext, input: unknown) {
      const creation = CreateMcpConnectionInputSchema.parse(input);
      const scope = adminScope(context, creation.workspaceId);
      const bindingId = randomUUID();
      const definitionId = randomUUID();
      const reference = `mcp:${bindingId}:r1`;
      const encrypted = seal(
        creation.bearerToken,
        key(),
        aad(scope, bindingId, 1),
      );
      await db().begin(async (tx) => {
        await tx`select id from allrice_workspaces where id=${scope.workspaceId} and organization_id=${scope.organizationId} for update`;
        await currentAdmin(tx, scope);
        const [count] = await tx<
          { count: number }[]
        >`select count(*)::integer as count from allrice_mcp_binding_config c join allrice_connector_bindings b on b.id=c.binding_id where c.organization_id=${scope.organizationId} and c.workspace_id=${scope.workspaceId} and b.enabled`;
        if ((count?.count ?? 0) >= 16) throw new McpError('MCP_LIMIT');
        await tx`insert into allrice_connector_definitions(id,organization_id,workspace_id,connector_key,name,description,capabilities,input_schema,risk,identity_modes,resource_scopes,created_by) values (${definitionId},${scope.organizationId},${scope.workspaceId},${`mcp.${bindingId}`},${creation.name},'Tenant-governed MCP tools',${tx.json(['network:outbound', 'secret:use'])},${tx.json({})},'write',${tx.json(['service'])},${tx.json(['workspace'])},${scope.actorId})`;
        await tx`insert into allrice_connector_bindings(id,organization_id,workspace_id,connector_id,identity_mode,user_id,credential_reference,resource_scope,created_by) values (${bindingId},${scope.organizationId},${scope.workspaceId},${definitionId},'service',null,${reference},${tx.json({ endpoint: creation.endpoint, transport: 'streamable-http', protocol: '2025-11-25' })},${scope.actorId})`;
        await tx`insert into allrice_mcp_binding_config(binding_id,organization_id,workspace_id,endpoint,credential_envelope) values (${bindingId},${scope.organizationId},${scope.workspaceId},${creation.endpoint},${tx.json(encrypted)})`;
        await audit(tx, scope, bindingId, 'mcp.connection.create');
      });
      return publicConnection(scope, bindingId);
    },
    async list(context: RequestContext, workspaceId: string) {
      const scope = adminScope(context, workspaceId);
      await currentAdmin(db(), scope);
      const rows = await db()<
        { binding_id: string }[]
      >`select binding_id from allrice_mcp_binding_config where transport='streamable_http' and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} order by binding_id`;
      return Promise.all(
        rows.map((row) => publicConnection(scope, row.binding_id)),
      );
    },
    async rotate(
      context: RequestContext,
      input: { workspaceId: string; connectionId: string; bearerToken: string },
    ) {
      const scope = adminScope(context, input.workspaceId);
      const token = McpBearerSchema.parse(input.bearerToken);
      await db().begin(async (tx) => {
        await currentAdmin(tx, scope);
        await tx`select binding_id from allrice_mcp_binding_config where binding_id=${UuidSchema.parse(input.connectionId)} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} for update`;
        const row = await read(scope, input.connectionId, tx);
        if (!row.enabled) throw new McpError('MCP_DENIED');
        const revision = row.revision + 1;
        await tx`update allrice_mcp_binding_config set revision=${revision},credential_envelope=${tx.json(seal(token, key(), aad(scope, row.id, revision)))},discovery_state='idle',discovery_owner=null,discovery_token_hash=null,discovery_lease_expires_at=null where binding_id=${row.id}`;
        await tx`update allrice_connector_bindings set credential_reference=${`mcp:${row.id}:r${revision}`},updated_at=now() where id=${row.id}`;
        await tx`update allrice_mcp_tool_grants set allowed=false,grant_revision=grant_revision+1 where binding_id=${row.id}`;
        await audit(tx, scope, row.id, 'mcp.credential.rotate', { revision });
      });
      return publicConnection(scope, input.connectionId);
    },
    async revoke(
      context: RequestContext,
      input: { workspaceId: string; connectionId: string },
    ) {
      const scope = adminScope(context, input.workspaceId);
      await db().begin(async (tx) => {
        await currentAdmin(tx, scope);
        await lockConnection(scope, input.connectionId, tx);
        const row = await read(scope, input.connectionId, tx);
        await tx`update allrice_connector_bindings set enabled=false,updated_at=now() where id=${row.id}`;
        await tx`update allrice_mcp_binding_config set revision=revision+1,discovery_state='idle',discovery_owner=null,discovery_token_hash=null,discovery_lease_expires_at=null where binding_id=${row.id}`;
        await tx`update allrice_mcp_tool_grants set allowed=false,grant_revision=grant_revision+1 where binding_id=${row.id}`;
        await audit(tx, scope, row.id, 'mcp.connection.revoke');
      });
      return publicConnection(scope, input.connectionId);
    },
    async queueDiscovery(
      context: RequestContext,
      input: { workspaceId: string; connectionId: string },
    ) {
      const scope = adminScope(context, input.workspaceId);
      await db().begin(async (tx) => {
        await currentAdmin(tx, scope);
        await lockConnection(scope, input.connectionId, tx);
        const row = await read(scope, input.connectionId, tx);
        if (!row.enabled) throw new McpError('MCP_DENIED');
        const result =
          await tx`update allrice_mcp_binding_config set discovery_state='queued',discovery_code=null where binding_id=${row.id} and (discovery_state <> 'running' or discovery_lease_expires_at < clock_timestamp()) returning binding_id`;
        if (!result.length) throw new McpError('MCP_UNAVAILABLE');
        await audit(tx, scope, row.id, 'mcp.discovery.queue');
      });
      return publicConnection(scope, input.connectionId);
    },
    async claimDiscovery(workerId: string): Promise<McpDiscoveryLease | null> {
      UuidSchema.parse(workerId);
      const token = randomBytes(32).toString('hex');
      return db().begin(async (tx) => {
        const [row] = await tx<
          {
            binding_id: string;
            organization_id: string;
            workspace_id: string;
            revision: number;
            endpoint: string;
            created_by: string;
            credential_reference: string;
          }[]
        >`select c.binding_id,c.organization_id,c.workspace_id,c.revision,c.endpoint,b.created_by,b.credential_reference from allrice_mcp_binding_config c join allrice_connector_bindings b on b.id=c.binding_id join allrice_connector_definitions d on d.id=b.connector_id where c.transport='streamable_http' and b.enabled and d.enabled and (c.discovery_state='queued' or (c.discovery_state='running' and c.discovery_lease_expires_at < clock_timestamp())) order by c.binding_id for update of c skip locked limit 1`;
        if (!row) return null;
        await tx`update allrice_mcp_binding_config set discovery_state='running',discovery_owner=${workerId},discovery_token_hash=${hash(token)},discovery_lease_expires_at=clock_timestamp()+interval '60 seconds' where binding_id=${row.binding_id}`;
        return {
          connectionId: row.binding_id,
          revision: row.revision,
          token,
          scope: {
            organizationId: row.organization_id,
            workspaceId: row.workspace_id,
            actorId: row.created_by,
          },
          endpoint: row.endpoint,
          credentialReference: row.credential_reference,
        };
      });
    },
    async discoveryCredential(lease: McpDiscoveryLease) {
      const row = await read(lease.scope, lease.connectionId);
      const [valid] =
        await db()`select binding_id from allrice_mcp_binding_config where binding_id=${lease.connectionId} and revision=${lease.revision} and discovery_state='running' and discovery_token_hash=${hash(lease.token)} and discovery_lease_expires_at > clock_timestamp()`;
      if (!valid || !row.enabled) throw new McpError('MCP_DISCOVERY_STALE');
      return unseal(
        row.credential_envelope,
        key(),
        aad(lease.scope, row.id, row.revision),
      );
    },
    async completeDiscovery(
      lease: McpDiscoveryLease,
      result:
        { tools: McpDiscoveredTool[] } | { errorCode: 'MCP_DISCOVERY_FAILED' },
    ) {
      const discovered =
        'tools' in result
          ? McpDiscoveredToolSchema.array().max(128).parse(result.tools)
          : null;
      if (
        discovered &&
        new Set(discovered.map((t) => t.name)).size !== discovered.length
      )
        throw new McpError('MCP_INVALID_SCHEMA');
      await db().begin(async (tx) => {
        const [valid] =
          await tx`select c.binding_id from allrice_mcp_binding_config c join allrice_connector_bindings b on b.id=c.binding_id where c.binding_id=${lease.connectionId} and c.organization_id=${lease.scope.organizationId} and c.workspace_id=${lease.scope.workspaceId} and c.revision=${lease.revision} and c.discovery_state='running' and c.discovery_token_hash=${hash(lease.token)} and c.discovery_lease_expires_at > clock_timestamp() and b.enabled for update of c`;
        if (!valid) throw new McpError('MCP_DISCOVERY_STALE');
        if (discovered) {
          const names = discovered.map((t) => t.name);
          await tx`update allrice_mcp_tool_grants set available=false,allowed=false,grant_revision=grant_revision+1 where binding_id=${lease.connectionId} and available and not (tool_name=any(${tx.array(names)}))`;
          for (const tool of discovered) {
            const digest = connectorInputDigest(tool);
            await tx`insert into allrice_mcp_tool_revisions(organization_id,workspace_id,binding_id,tool_name,digest,definition) values (${lease.scope.organizationId},${lease.scope.workspaceId},${lease.connectionId},${tool.name},${digest},${tx.json(JSON.parse(JSON.stringify(tool)))}) on conflict(binding_id,tool_name,digest) do nothing`;
            const [revision] = await tx<
              { id: string }[]
            >`select id from allrice_mcp_tool_revisions where binding_id=${lease.connectionId} and tool_name=${tool.name} and digest=${digest}`;
            await tx`insert into allrice_mcp_tool_grants(organization_id,workspace_id,binding_id,tool_name,revision_id) values (${lease.scope.organizationId},${lease.scope.workspaceId},${lease.connectionId},${tool.name},${revision!.id}) on conflict(binding_id,tool_name) do update set revision_id=excluded.revision_id,available=true,allowed=case when allrice_mcp_tool_grants.revision_id=excluded.revision_id and allrice_mcp_tool_grants.available then allrice_mcp_tool_grants.allowed else false end,grant_revision=allrice_mcp_tool_grants.grant_revision+case when allrice_mcp_tool_grants.revision_id<>excluded.revision_id or not allrice_mcp_tool_grants.available then 1 else 0 end,updated_at=now()`;
          }
        }
        await tx`update allrice_mcp_binding_config set discovery_state=${discovered ? 'ready' : 'error'},discovery_code=${discovered ? null : 'MCP_DISCOVERY_FAILED'},checked_at=clock_timestamp(),discovery_owner=null,discovery_token_hash=null,discovery_lease_expires_at=null where binding_id=${lease.connectionId}`;
        await audit(
          tx,
          lease.scope,
          lease.connectionId,
          'mcp.discovery.complete',
          { success: discovered !== null, toolCount: discovered?.length ?? 0 },
        );
      });
    },
    async grant(context: RequestContext, input: unknown) {
      const grant = McpGrantInputSchema.parse(input);
      const scope = adminScope(context, grant.workspaceId);
      await db().begin(async (tx) => {
        await currentAdmin(tx, scope);
        await lockConnection(scope, grant.connectionId, tx);
        const row = await read(scope, grant.connectionId, tx);
        if (!row.enabled) throw new McpError('MCP_DENIED');
        const updated =
          await tx`update allrice_mcp_tool_grants set allowed=${grant.allowed},risk=${grant.risk},grant_revision=grant_revision+1,granted_by=${scope.actorId},updated_at=now() where binding_id=${row.id} and revision_id=${grant.revisionId} and available returning tool_name`;
        if (!updated.length) throw new McpError('MCP_DENIED');
        await audit(tx, scope, row.id, 'mcp.tool.grant', {
          revisionId: grant.revisionId,
          allowed: grant.allowed,
          risk: grant.risk,
        });
      });
      return publicConnection(scope, grant.connectionId);
    },
    async freeze(
      scopeInput: McpScope,
      connectionIds?: readonly string[],
    ): Promise<FrozenMcpTool[]> {
      const scope = McpScopeSchema.parse(scopeInput);
      const rows = await db()<
        { binding_id: string }[]
      >`select c.binding_id from allrice_mcp_binding_config c join allrice_connector_bindings b on b.id=c.binding_id join allrice_connector_definitions d on d.id=b.connector_id where c.transport='streamable_http' and c.organization_id=${scope.organizationId} and c.workspace_id=${scope.workspaceId} and b.enabled and d.enabled`;
      const frozen: FrozenMcpTool[] = [];
      for (const row of rows) {
        if (connectionIds && !connectionIds.includes(row.binding_id)) continue;
        const c = await read(scope, row.binding_id);
        for (const tool of await tools(scope, c.id))
          if (tool.available && tool.allowed)
            frozen.push(
              FrozenMcpToolSchema.parse({
                ...tool.definition,
                connectionId: c.id,
                connectionRevision: c.revision,
                toolRevisionId: tool.id,
                digest: tool.digest,
                grantRevision: tool.grant_revision,
                risk: tool.risk,
                credentialReference: c.credential_reference,
              }),
            );
      }
      if (frozen.length > 128) throw new McpError('MCP_LIMIT');
      return frozen;
    },
    assertAuthorized,
    /** Display-only service. Caller must first authorize the owning Run. It
     * never returns a credential or silently trusts an unavailable decryption
     * key: that case hides string values while preserving historical state. */
    async redactForDisplay(
      scope: McpScope,
      connectionId: string,
      value: unknown,
    ) {
      let secret: string | null = null;
      try {
        const row = await read(scope, connectionId);
        const revision = /^mcp:[a-f0-9-]+:r([0-9]+)$/.exec(
          row.credential_reference,
        )?.[1];
        if (!revision) throw new McpError('MCP_CREDENTIAL_UNAVAILABLE');
        secret = unseal(
          row.credential_envelope,
          key(),
          aad(scope, row.id, Number(revision)),
        );
      } catch {
        /* Fail closed for parameter strings, not historical visibility. */
      }
      const visit = (entry: unknown, depth = 0): unknown => {
        if (depth > 24) return '[REDACTED: depth limit]';
        if (typeof entry === 'string')
          return secret === null
            ? '[REDACTED: credential unavailable]'
            : entry
                .replaceAll(secret, '[REDACTED]')
                .replace(
                  /(?:Bearer\s+|\bsk-|\bAIza|\bAQ\.)[A-Za-z0-9_./-]{12,}/g,
                  '[REDACTED]',
                );
        if (Array.isArray(entry)) return entry.map((v) => visit(v, depth + 1));
        if (entry && typeof entry === 'object')
          return Object.fromEntries(
            Object.entries(entry).map(([key, v]) => [
              secret ? key.replaceAll(secret, '[REDACTED]') : key,
              /authorization|password|secret|token|api[-_]?key|cookie|credential/i.test(
                key,
              )
                ? '[REDACTED]'
                : visit(v, depth + 1),
            ]),
          );
        return entry;
      };
      return visit(value);
    },
    async executionCredential(scope: McpScope, frozen: FrozenMcpTool) {
      await assertAuthorized(scope, frozen);
      const row = await read(scope, frozen.connectionId);
      if (row.revision !== frozen.connectionRevision)
        throw new McpError('MCP_DENIED');
      return unseal(
        row.credential_envelope,
        key(),
        aad(scope, row.id, row.revision),
      );
    },
  };
}
export type McpStore = ReturnType<typeof createMcpStore>;
