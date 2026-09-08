import { createMcpStore, DataAccessError } from '@allrice/database';
import {
  McpError,
  UuidSchema,
  McpManagementMutationSchema,
  isMcpInputValidationError,
} from '@allrice/contracts';

import { requireRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
function failure(error: unknown) {
  if (error instanceof DataAccessError)
    return Response.json(
      {
        error: {
          code: 'MCP_DENIED',
          message: '请先登录并确认当前租户管理权限。',
        },
      },
      { status: error.code === 'authentication_required' ? 401 : 403, headers },
    );
  const code =
    error instanceof McpError
      ? error.code
      : isMcpInputValidationError(error) || error instanceof SyntaxError
        ? 'MCP_INVALID_INPUT'
        : 'MCP_UNAVAILABLE';
  return Response.json(
    {
      error: {
        code,
        message:
          code === 'MCP_DENIED'
            ? '没有此租户 MCP 的管理权限。'
            : code === 'MCP_CREDENTIAL_UNAVAILABLE'
              ? '服务端 MCP 密钥加密配置不可用。'
              : 'MCP 请求未完成，请检查配置和权限后重试。',
      },
    },
    {
      status:
        code === 'MCP_DENIED' ? 403 : code === 'MCP_INVALID_INPUT' ? 400 : 503,
      headers,
    },
  );
}
async function body(request: Request) {
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    throw new McpError('MCP_DENIED');
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new McpError('MCP_DENIED');
  const reader = request.body?.getReader();
  if (!reader) throw new McpError('MCP_DENIED');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new McpError('MCP_LIMIT');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
function requireEnabled() {
  if (process.env.ALLRICE_CLOUD_MCP_ENABLED !== '1')
    throw new McpError('MCP_UNAVAILABLE');
}
export async function GET(request: Request) {
  try {
    const context = await requireRequestContext(request);
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId'),
    );
    return Response.json(
      {
        enabled: process.env.ALLRICE_CLOUD_MCP_ENABLED === '1',
        protocol: '2025-11-25',
        auth: 'tenant_bearer',
        connections: await createMcpStore().list(context, workspaceId),
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    requireEnabled();
    const context = await requireRequestContext(request);
    const input = await body(request);
    return Response.json(
      { connection: await createMcpStore().create(context, input) },
      { status: 201, headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  try {
    requireEnabled();
    const context = await requireRequestContext(request);
    const input = McpManagementMutationSchema.parse(await body(request));
    const store = createMcpStore();
    let connection;
    switch (input.action) {
      case 'discover':
        connection = await store.queueDiscovery(context, input);
        break;
      case 'revoke':
        connection = await store.revoke(context, input);
        break;
      case 'rotate':
        connection = await store.rotate(context, input);
        break;
      case 'grant': {
        connection = await store.grant(context, {
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
          revisionId: input.revisionId,
          allowed: input.allowed,
          risk: input.risk,
        });
        break;
      }
    }
    return Response.json({ connection }, { headers });
  } catch (error) {
    return failure(error);
  }
}
