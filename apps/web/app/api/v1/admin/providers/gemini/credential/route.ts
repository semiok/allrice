import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function retired(request: Request) {
  try {
    await requirePlatformAdminContext(request);
    return Response.json(
      {
        error: {
          code: 'PROVIDER_RETIRED',
          message: 'Gemini 已停止接入，请在平台模型配置中使用 Codex 订阅。',
        },
      },
      { status: 410, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export const GET = retired;
export const PUT = retired;
export const POST = retired;
export const DELETE = retired;
