import { DataAccessError, getStoredFile } from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';
import { readStaticArtifactPreview } from '../../../../../../lib/runtime/static-artifact-preview';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const login = await getRequestContext(request);
    if (!login) throw new DataAccessError('authentication_required');
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId'),
    );
    const context = { ...login, workspaceId };
    const { id } = await route.params;
    const file = await getStoredFile(context, UuidSchema.parse(id));
    const preview = await readStaticArtifactPreview({
      object: file.object,
      kind: 'file',
    });
    await getStoredFile(context, id);
    return Response.json(preview, {
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
