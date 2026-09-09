import {
  createLocalMcpStore,
  createEmployeeMcpBindingStore,
  localMcpEnabled,
  DataAccessError,
  listBridgeDevices,
} from '@allrice/database';
import {
  LocalMcpMutationSchema,
  McpError,
  UuidSchema,
  isMcpInputValidationError,
} from '@allrice/contracts';
import { requireRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
function failure(error: unknown) {
  const code =
    error instanceof DataAccessError
      ? 'MCP_DENIED'
      : error instanceof McpError
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
            ? '没有此设备/租户的管理权限'
            : code === 'MCP_BINDING_CHANGED'
              ? '配置版本已变化，请刷新后确认'
              : code === 'MCP_INVALID_INPUT'
                ? '配置格式不正确，请检查来源文件清单和版本'
                : '本地 MCP 配置暂不可用',
      },
    },
    {
      headers,
      status:
        error instanceof DataAccessError &&
        error.code === 'authentication_required'
          ? 401
          : code === 'MCP_DENIED'
            ? 403
            : code === 'MCP_BINDING_CHANGED'
              ? 409
              : code === 'MCP_INVALID_INPUT'
                ? 400
                : 503,
    },
  );
}
async function body(request: Request) {
  if (
    !sameOriginBrowserWrite(request) ||
    request.headers.get('content-type')?.split(';')[0] !== 'application/json'
  )
    throw new McpError('MCP_DENIED');
  const reader = request.body?.getReader();
  if (!reader) throw new McpError('MCP_DENIED');
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 40000) {
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
export async function GET(request: Request) {
  try {
    const context = await requireRequestContext(request),
      workspaceId = UuidSchema.parse(
        new URL(request.url).searchParams.get('workspaceId'),
      );
    const connections = await createLocalMcpStore().list(context, workspaceId);
    return Response.json(
      {
        enabled: localMcpEnabled(),
        connections,
        employees: await createEmployeeMcpBindingStore({
          transport: 'local_stdio',
        }).list(context, workspaceId),
        devices: await listBridgeDevices(context, workspaceId),
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    if (!localMcpEnabled()) throw new McpError('MCP_UNAVAILABLE');
    const context = await requireRequestContext(request);
    return Response.json(
      {
        connection: await createLocalMcpStore().create(
          context,
          await body(request),
        ),
      },
      { status: 201, headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  try {
    const context = await requireRequestContext(request),
      input = LocalMcpMutationSchema.parse(await body(request));
    // Revocation remains possible even while execution feature flags are OFF.
    if (
      !localMcpEnabled() &&
      input.action !== 'revoke' &&
      !(input.action === 'employee_binding' && !input.enabled) &&
      !(input.action === 'grant' && !input.allowed)
    )
      throw new McpError('MCP_UNAVAILABLE');
    const store = createLocalMcpStore();
    if (input.action === 'employee_binding')
      return Response.json(
        {
          binding: await createEmployeeMcpBindingStore({
            transport: 'local_stdio',
          }).bind(
            context,
            (({ action, ...rest }) => {
              void action;
              return rest;
            })(input),
          ),
        },
        { headers },
      );
    if (input.action === 'grant')
      return Response.json(
        {
          connection: await store.grant(
            context,
            (({ action, ...rest }) => {
              void action;
              return rest;
            })(input),
          ),
        },
        { headers },
      );
    return Response.json(
      {
        connection: await store.replace(context, {
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
          expectedRevision: input.expectedRevision,
          ...(input.action === 'revoke'
            ? { revoke: true }
            : { configuration: input.configuration }),
        }),
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
