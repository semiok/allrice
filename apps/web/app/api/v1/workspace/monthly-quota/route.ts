import { UuidSchema } from '@allrice/contracts';
import { DataAccessError, getUserMonthlyQuota } from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context)
      return Response.json(
        { code: 'AUTHENTICATION_REQUIRED' },
        { status: 401, headers },
      );
    const workspace = UuidSchema.safeParse(
      new URL(request.url).searchParams.get('workspaceId'),
    );
    if (!workspace.success)
      return Response.json(
        { code: 'INVALID_REQUEST' },
        { status: 400, headers },
      );
    return Response.json(await getUserMonthlyQuota(context, workspace.data), {
      headers,
    });
  } catch (error) {
    const status =
      error instanceof DataAccessError
        ? error.code === 'authentication_required'
          ? 401
          : 403
        : 503;
    return Response.json(
      { code: status === 503 ? 'QUOTA_UNAVAILABLE' : 'QUOTA_DENIED' },
      { status, headers },
    );
  }
}
