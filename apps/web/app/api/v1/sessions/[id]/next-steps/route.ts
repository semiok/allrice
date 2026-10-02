import {
  ArtifactReviewError,
  DataAccessError,
  readTaskNextSteps,
} from '@allrice/database';
import {
  TaskNextStepsInputSchema,
  runtimeStaticPreviewPolicy,
} from '@allrice/contracts';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';

export const runtime = 'nodejs';
const headers = {
  'Cache-Control': 'private, no-store',
  ...runtimeStaticPreviewPolicy('application/json').responseHeaders,
};

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) return new Response(null, { status: 401, headers });
    const query = new URL(request.url).searchParams;
    const input = TaskNextStepsInputSchema.parse({
      sessionId: (await route.params).id,
      workspaceId: query.get('workspaceId') ?? context.workspaceId,
      employeeAssignmentId: query.get('employeeAssignmentId'),
      employeeVersionId: query.get('employeeVersionId'),
    });
    return Response.json(
      await readTaskNextSteps(
        { ...context, workspaceId: input.workspaceId },
        input,
      ),
      { headers },
    );
  } catch (error) {
    const response = executionErrorResponse(
      error instanceof ArtifactReviewError &&
        (error.code === 'identity_denied' ||
          error.code === 'artifact_not_found')
        ? new DataAccessError(
            error.code === 'identity_denied'
              ? 'authorization_denied'
              : 'not_found',
          )
        : error,
    );
    for (const [key, value] of Object.entries(headers))
      response.headers.set(key, value);
    return response;
  }
}
