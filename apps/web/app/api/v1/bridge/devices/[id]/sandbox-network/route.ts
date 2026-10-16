import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { runtimeFeatureEnabled } from '@allrice/contracts';
import {
  DataAccessError,
  RuntimePolicyError,
  getBridgeSandboxNetwork,
  updateBridgeSandboxNetwork,
} from '@allrice/database';
import { bridgeErrorResponse } from '../../../../../../../lib/bridge/responses';
import { getRequestContext } from '../../../../../../../lib/identity/session';

export const runtime = 'nodejs';
type Route = { params: Promise<{ id: string }> };
async function body(request: Request) {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    throw new SyntaxError('JSON required');
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('Missing body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new RangeError('Body too large');
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    reader.releaseLock();
  }
}
async function respond(request: Request, route: Route, update: boolean) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    if (!runtimeFeatureEnabled('ALLRICE_SANDBOX_NETWORK_ENABLED'))
      return Response.json(
        { error: { message: '当前环境尚未启用沙箱联网设置。' } },
        { status: 404, headers },
      );
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    if (update && !sameOriginBrowserWrite(request))
      throw new RuntimePolicyError('origin_denied');
    const { id } = await route.params;
    const settings = update
      ? await updateBridgeSandboxNetwork(
          context,
          workspaceId,
          id,
          await body(request),
        )
      : await getBridgeSandboxNetwork(context, workspaceId, id);
    return Response.json(settings, { headers });
  } catch (error) {
    if (error instanceof RuntimePolicyError) {
      const conflict = error.code === 'bridge_network_settings_conflict';
      return Response.json(
        {
          error: {
            message: conflict
              ? '设置已变化，请重新打开后再保存。'
              : '仅电脑的配对用户可以管理此授权。',
          },
        },
        { status: conflict ? 409 : 403, headers },
      );
    }
    if (error instanceof SyntaxError || error instanceof RangeError)
      return Response.json(
        { error: { message: '请检查授权地址格式与数量。' } },
        { status: 400, headers },
      );
    return bridgeErrorResponse(error);
  }
}
export const GET = (request: Request, route: Route) =>
  respond(request, route, false);
export const PATCH = (request: Request, route: Route) =>
  respond(request, route, true);
