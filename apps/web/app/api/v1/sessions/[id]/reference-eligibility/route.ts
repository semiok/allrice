import {
  DataAccessError,
  readSessionReferenceEligibility,
} from '@allrice/database';
import {
  referenceContext,
  referenceError,
  referenceHeaders,
} from '../../../../../../lib/reference-library';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await referenceContext(request);
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    return Response.json(
      await readSessionReferenceEligibility(
        context,
        workspaceId,
        (await route.params).id,
      ),
      { headers: referenceHeaders },
    );
  } catch (error) {
    return referenceError(error);
  }
}
