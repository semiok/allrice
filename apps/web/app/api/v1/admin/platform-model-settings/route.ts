import {
  getPlatformModelSettings,
  updatePlatformModelSettings,
  PlatformModelSettingsConflict,
} from '@allrice/database';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../lib/execution/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    const context = await requirePlatformAdminContext(request);
    return Response.json(
      { settings: await getPlatformModelSettings(context) },
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      return Response.json(
        { error: { message: '请求来源无效' } },
        { status: 403, headers },
      );
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return Response.json(
        { error: { message: '请提交 JSON 配置' } },
        { status: 415, headers },
      );
    const context = await requirePlatformAdminContext(request);
    return Response.json(
      {
        settings: await updatePlatformModelSettings(
          context,
          await request.json(),
        ),
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof PlatformModelSettingsConflict)
      return Response.json(
        {
          error: {
            code: 'CONFIGURATION_CONFLICT',
            message: '配置已被更新，请刷新后重试。',
          },
        },
        { status: 409, headers },
      );
    return executionErrorResponse(error);
  }
}
