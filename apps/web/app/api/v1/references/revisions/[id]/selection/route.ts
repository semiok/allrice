import { readReferenceInputSelection } from '@allrice/database';
import {
  ReferenceInputSelectionResultSchema,
  UuidSchema,
} from '@allrice/contracts';
import {
  referenceContext,
  referenceError,
  referenceHeaders,
} from '../../../../../../../lib/reference-library';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await referenceContext(request);
    const { id } = await route.params;
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId'),
    );
    return Response.json(
      ReferenceInputSelectionResultSchema.parse(
        await readReferenceInputSelection(context, workspaceId, id),
      ),
      { headers: referenceHeaders },
    );
  } catch (error) {
    return referenceError(error);
  }
}
