import {
  getInteractionStatus,
  workbenchEnabled,
  ArtifactReviewError,
} from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../../lib/identity/session';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  if (!workbenchEnabled()) return new Response(null, { status: 404, headers });
  try {
    const login = await getRequestContext(request);
    if (!login) return new Response(null, { status: 401, headers });
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId') ?? login.workspaceId,
    );
    return Response.json(
      await getInteractionStatus(
        { ...login, workspaceId },
        UuidSchema.parse((await route.params).id),
      ),
      { headers },
    );
  } catch (error) {
    return Response.json(
      { code: 'INTERACTION_UNAVAILABLE' },
      { status: error instanceof ArtifactReviewError ? 403 : 400, headers },
    );
  }
}
