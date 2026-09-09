import { UuidSchema } from '@allrice/contracts';
import {
  DataAccessError,
  RuntimePolicyError,
  listBrowserControlManagement,
} from '@allrice/database';
import { requireRequestContext } from '../../../../../lib/identity/session';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const context = await requireRequestContext(request);
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId'),
    );
    return Response.json(
      await listBrowserControlManagement({ ...context, workspaceId }),
      { headers },
    );
  } catch (error) {
    const status =
      error instanceof DataAccessError &&
      error.code === 'authentication_required'
        ? 401
        : error instanceof DataAccessError ||
            error instanceof RuntimePolicyError
          ? 403
          : error instanceof Error && error.name === 'ZodError'
            ? 400
            : 503;
    return Response.json(
      {
        error: {
          code: 'BROWSER_MANAGEMENT_UNAVAILABLE',
          message: '请确认当前租户、工作区与管理员权限。',
        },
      },
      { status, headers },
    );
  }
}
