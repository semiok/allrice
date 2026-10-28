import {
  getNativeQuestionMode,
  updateNativeQuestionMode,
} from '@allrice/database';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../lib/execution/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
export async function GET(request: Request) {
  try {
    return Response.json(
      {
        mode: await getNativeQuestionMode(
          await requirePlatformAdminContext(request),
        ),
      },
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
    const context = await requirePlatformAdminContext(request);
    return Response.json(
      {
        mode: await updateNativeQuestionMode(
          context,
          (await request.json()).mode,
        ),
      },
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
