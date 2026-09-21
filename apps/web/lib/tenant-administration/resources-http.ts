import {
  TenantConnectorEnvelopeSchema,
  UuidSchema,
  McpError,
  CreateMcpConnectionInputSchema,
  McpManagementMutationSchema,
  CreateLocalMcpConnectionSchema,
  LocalMcpMutationSchema,
} from '@allrice/contracts';
import {
  getAdminTenantQuotas,
  updateAdminTenantQuota,
  TenantQuotaConflict,
  getAdminTenantEnvironments,
  mutateAdminTenantEnvironment,
  RuntimePolicyError,
  createMcpStore,
  createLocalMcpStore,
  createEmployeeMcpBindingStore,
  requireTenantManagementScope,
  getDatabase,
  listBridgeDevices,
  localMcpEnabled,
  mcpExecutionEnabled,
  type TenantManagementOptions,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { executionErrorResponse } from '../execution/responses';
import { readAdminJson } from './http';
const headers = { 'Cache-Control': 'private, no-store' };
type Resource = 'quotas' | 'environments' | 'mcp' | 'local-mcp';
const envelope = TenantConnectorEnvelopeSchema;
export async function tenantResourcesHttp(
  request: Request,
  organizationInput: string,
  resource: Resource,
) {
  try {
    const context = await requirePlatformAdminContext(request),
      organizationId = UuidSchema.parse(organizationInput);
    const query = new URL(request.url).searchParams;
    if (request.method === 'GET') {
      const target = {
        organizationId,
        workspaceId: UuidSchema.parse(query.get('workspaceId')),
        subjectId: UuidSchema.parse(query.get('subjectId')),
      };
      if (resource === 'quotas')
        return Response.json(await getAdminTenantQuotas(context, target), {
          headers,
        });
      if (resource === 'environments')
        return Response.json(
          await getAdminTenantEnvironments(context, target),
          { headers },
        );
      await requireTenantManagementScope(context, target, getDatabase());
      const local = resource === 'local-mcp',
        administration = {
          ...target,
          issuer: context,
          reason: 'read-only inventory',
        };
      const store = local
        ? createLocalMcpStore({ administration })
        : createMcpStore({ administration });
      return Response.json(
        {
          ...target,
          enabled: local ? localMcpEnabled() : mcpExecutionEnabled(),
          connections: await store.list(context, target.workspaceId),
          employees: await createEmployeeMcpBindingStore({
            administration,
            transport: local ? 'local_stdio' : 'streamable_http',
          }).list(context, target.workspaceId),
          devices: local
            ? await listBridgeDevices(
                context,
                target.workspaceId,
                getDatabase(),
                target,
              )
            : [],
        },
        { headers },
      );
    }
    if (!sameOriginBrowserWrite(request))
      return Response.json(
        { code: 'AUTHORIZATION_DENIED', error: { message: '仅允许同源修改' } },
        { status: 403, headers },
      );
    const raw = await readAdminJson(request, 48000);
    if (resource === 'quotas')
      return Response.json(
        await updateAdminTenantQuota(context, organizationId, raw),
        { headers },
      );
    if (resource === 'environments')
      return Response.json(
        await mutateAdminTenantEnvironment(context, organizationId, raw),
        { headers },
      );
    const parsed = envelope.parse(raw),
      {
        subjectId,
        reason,
        expectedConnectionRevision,
        expectedToolGrantRevision,
        ...payload
      } = raw as Record<string, unknown>;
    void subjectId;
    void reason;
    void expectedConnectionRevision;
    void expectedToolGrantRevision;
    const local = resource === 'local-mcp',
      administration: TenantManagementOptions = {
        organizationId,
        workspaceId: parsed.workspaceId,
        subjectId: parsed.subjectId,
        issuer: context,
        reason: parsed.reason,
      };
    await requireTenantManagementScope(context, administration, getDatabase());
    const body =
      request.method === 'POST'
        ? (local
            ? CreateLocalMcpConnectionSchema
            : CreateMcpConnectionInputSchema
          ).parse(payload)
        : (local ? LocalMcpMutationSchema : McpManagementMutationSchema).parse(
            payload,
          );
    const action = 'action' in body ? body.action : 'create';
    const revoking =
      action === 'revoke' ||
      ('enabled' in body && !body.enabled) ||
      ('allowed' in body && !body.allowed);
    if (!(local ? localMcpEnabled() : mcpExecutionEnabled()) && !revoking)
      throw new McpError('MCP_UNAVAILABLE');
    if ('action' in body && body.action !== 'employee_binding') {
      if (!parsed.expectedConnectionRevision)
        throw new McpError('MCP_BINDING_CHANGED');
      administration.expectedConnection = {
        id: body.connectionId,
        revision: parsed.expectedConnectionRevision,
        ...('revisionId' in body
          ? {
              toolRevisionId: body.revisionId,
              toolGrantRevision: parsed.expectedToolGrantRevision,
            }
          : {}),
      };
    }
    // No raw credential, endpoint response or model text is ever echoed on errors.
    const cloud = createMcpStore({ administration }),
      device = createLocalMcpStore({ administration });
    let result: unknown;
    if (!('action' in body))
      result = local
        ? await device.create(context, body)
        : await cloud.create(context, body);
    else {
      const { action, ...input } = body;
      if (action === 'employee_binding')
        result = await createEmployeeMcpBindingStore({
          administration,
          transport: local ? 'local_stdio' : 'streamable_http',
        }).bind(context, input);
      else if (action === 'grant')
        result = local
          ? await device.grant(context, input)
          : await cloud.grant(context, input);
      else if (local) {
        const checked = LocalMcpMutationSchema.parse(body);
        if (checked.action !== 'replace' && checked.action !== 'revoke')
          throw new McpError('MCP_INVALID_SCHEMA');
        result = await device.replace(context, {
          ...checked,
          revoke: checked.action === 'revoke',
        });
      } else {
        const checked = McpManagementMutationSchema.parse(body);
        if (checked.action === 'rotate')
          result = await cloud.rotate(context, checked);
        else if (checked.action === 'discover')
          result = await cloud.queueDiscovery(context, checked);
        else if (checked.action === 'revoke')
          result = await cloud.revoke(context, checked);
      }
    }
    return Response.json(
      {
        organizationId,
        workspaceId: parsed.workspaceId,
        subjectId: parsed.subjectId,
        result,
      },
      { headers },
    );
  } catch (error) {
    if (
      error instanceof TenantQuotaConflict ||
      error instanceof McpError ||
      error instanceof RuntimePolicyError ||
      error instanceof SyntaxError
    ) {
      const code =
        error instanceof TenantQuotaConflict
          ? 'CONFLICT'
          : error instanceof McpError
            ? error.code
            : error instanceof RuntimePolicyError
              ? error.code
              : 'INVALID_REQUEST';
      const conflict = [
        'CONFLICT',
        'MCP_BINDING_CHANGED',
        'cloud_grant_unavailable',
        'browser_grant_unavailable',
      ].includes(code);
      const message = conflict
        ? '配置已变化，请刷新并重新确认；不会自动重发。'
        : '配置未完成，请检查前置条件、授权范围及格式；不会自动重发。';
      return Response.json(
        { code, error: { code, message } },
        { status: conflict ? 409 : 400, headers },
      );
    }
    return executionErrorResponse(error);
  }
}
