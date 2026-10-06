import {
  createPlatformRepositoryReview,
  findPlatformRepositoryReview,
  getPlatformRepositoryReviewPanel,
  getPlatformRepositoryCredential,
} from '@allrice/database';
import {
  RepositoryReviewRequestSchema,
  RepositoryReviewPanelSchema,
  RepositoryReviewViewSchema,
} from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { readAdminJson } from '../../../../../../lib/tenant-administration/http';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    const context = await requirePlatformAdminContext(request),
      query = new URL(request.url).searchParams;
    const requestId = query.get('requestId');
    if (requestId)
      return Response.json(
        {
          review: RepositoryReviewViewSchema.nullable().parse(
            await findPlatformRepositoryReview(context, requestId),
          ),
        },
        { headers },
      );
    const publicationId = query.get('publicationId');
    if (!publicationId) return new Response(null, { status: 400, headers });
    const credential = await getPlatformRepositoryCredential(context);
    return Response.json(
      RepositoryReviewPanelSchema.parse(
        await getPlatformRepositoryReviewPanel(
          context,
          publicationId,
          credential.state === 'configured' ? credential.revision : null,
        ),
      ),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    if (
      !sameOriginBrowserWrite(request) ||
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return new Response(null, { status: 403, headers });
    const context = await requirePlatformAdminContext(request);
    return Response.json(
      RepositoryReviewViewSchema.parse(
        await createPlatformRepositoryReview(
          context,
          RepositoryReviewRequestSchema.parse(
            await readAdminJson(request, 1024),
          ),
        ),
      ),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
