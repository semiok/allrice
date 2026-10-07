import {
  createPlatformRepositoryMerge,
  findPlatformRepositoryMerge,
  getPlatformRepositoryMergePanel,
  getPlatformRepositoryCredential,
} from '@allrice/database';
import {
  RepositoryMergeRequestSchema,
  RepositoryMergePanelSchema,
  RepositoryMergeViewSchema,
} from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { readAdminJson } from '../../../../../../lib/tenant-administration/http';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import {
  platformAutonomyPaused,
  deferredPlatformActionResponse,
} from '../../../../../../lib/execution/platform-autonomy';
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
          merge: RepositoryMergeViewSchema.nullable().parse(
            await findPlatformRepositoryMerge(context, requestId),
          ),
        },
        { headers },
      );
    const publicationId = query.get('publicationId');
    if (!publicationId) return new Response(null, { status: 400, headers });
    const credential = await getPlatformRepositoryCredential(context);
    return Response.json(
      RepositoryMergePanelSchema.parse(
        await getPlatformRepositoryMergePanel(
          context,
          publicationId,
          credential.state === 'configured' ? credential.revision : null,
        ),
      ),
      { headers },
    );
  } catch (e) {
    return executionErrorResponse(e);
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
    if (platformAutonomyPaused()) return deferredPlatformActionResponse();
    return Response.json(
      RepositoryMergeViewSchema.parse(
        await createPlatformRepositoryMerge(
          context,
          RepositoryMergeRequestSchema.parse(
            await readAdminJson(request, 1024),
          ),
        ),
      ),
      { headers },
    );
  } catch (e) {
    return executionErrorResponse(e);
  }
}
