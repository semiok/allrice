import { UuidSchema } from '@allrice/contracts';
import {
  DataAccessError,
  setWorkbenchFileFavorite,
  WorkbenchFileError,
} from '@allrice/database';
import {
  workbenchFileContext,
  workbenchFileError,
  workbenchFileHeaders,
} from '../../../../../../../lib/workbench-files';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PUT(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await workbenchFileContext(request, true);
    if (context.actor.type !== 'user')
      throw new DataAccessError('authentication_required');
    // A consistency precondition, never the authority or owner of this write.
    const expected = request.headers.get('x-allrice-expected-viewer-id');
    if (expected !== null && expected !== context.actor.id)
      throw new WorkbenchFileError('request_conflict', '操作未完成，请重试。');
    const { id } = await route.params;
    return Response.json(
      await setWorkbenchFileFavorite(
        context,
        UuidSchema.parse(id),
        await request.json(),
      ),
      { headers: workbenchFileHeaders },
    );
  } catch (error) {
    return workbenchFileError(error);
  }
}
