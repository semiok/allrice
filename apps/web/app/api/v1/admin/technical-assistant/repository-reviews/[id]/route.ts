import {
  getPlatformRepositoryReview,
  cancelPlatformRepositoryReview,
} from '@allrice/database';
import { RepositoryReviewViewSchema } from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
import {
  platformAutonomyPaused,
  deferredPlatformActionResponse,
} from '../../../../../../../lib/execution/platform-autonomy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    return Response.json(
      RepositoryReviewViewSchema.parse(
        await getPlatformRepositoryReview(
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
    await requirePlatformAdminContext(request);
    if (platformAutonomyPaused()) return deferredPlatformActionResponse();
    return Response.json(
      RepositoryReviewViewSchema.parse(
        await cancelPlatformRepositoryReview(
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
