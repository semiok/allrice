import {
  getPlatformRepositoryPublication,
  cancelPlatformRepositoryAction,
} from '@allrice/database';
import { RepositoryPublicationSchema } from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    return Response.json(
      RepositoryPublicationSchema.parse(
        await getPlatformRepositoryPublication(
          await requirePlatformAdminContext(request),
          (await params).id,
        ),
      ),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function DELETE(request: Request, { params }: Context) {
  try {
    if (!sameOriginBrowserWrite(request))
      return new Response(null, { status: 403, headers });
    const actionId = new URL(request.url).searchParams.get('actionId');
    if (!actionId) return new Response(null, { status: 400, headers });
    return Response.json(
      RepositoryPublicationSchema.parse(
        await cancelPlatformRepositoryAction(
          await requirePlatformAdminContext(request),
          (await params).id,
          actionId,
        ),
      ),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
