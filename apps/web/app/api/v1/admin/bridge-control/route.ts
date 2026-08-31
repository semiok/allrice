import { controlSnowBridge } from '../../../../../lib/bridge/snow-ssh-control';
import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(reason: unknown) {
  console.error('Snow Bridge control failed', {
    message: reason instanceof Error ? reason.message : 'Unknown failure',
  });
  return Response.json(
    { error: { message: '无法连接 Snow Mac，请检查 SSH 或电脑在线状态' } },
    { status: 502 },
  );
}

export async function GET(request: Request) {
  try {
    await requirePlatformAdminContext(request);
  } catch (reason) {
    return executionErrorResponse(reason);
  }
  try {
    return Response.json(await controlSnowBridge('status'));
  } catch (reason) {
    return errorResponse(reason);
  }
}

export async function POST(request: Request) {
  try {
    await requirePlatformAdminContext(request);
  } catch (reason) {
    return executionErrorResponse(reason);
  }
  try {
    const body = (await request.json()) as { action?: unknown };
    if (body.action !== 'start' && body.action !== 'stop') {
      return Response.json(
        { error: { message: '只允许启动或关闭 Snow Bridge' } },
        { status: 400 },
      );
    }
    return Response.json(await controlSnowBridge(body.action));
  } catch (reason) {
    return errorResponse(reason);
  }
}
