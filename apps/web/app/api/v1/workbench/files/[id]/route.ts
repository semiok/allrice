import { UuidSchema } from '@allrice/contracts';
import { updateWorkbenchFile } from '@allrice/database';
import {
  workbenchFileContext,
  workbenchFileError,
  workbenchFileHeaders,
} from '../../../../../../lib/workbench-files';
import { getStorageAdapter } from '../../../../../../lib/storage/runtime';
export const runtime = 'nodejs';
export async function PATCH(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await workbenchFileContext(request, true),
      { id } = await route.params;
    const result = await updateWorkbenchFile(
      context,
      UuidSchema.parse(id),
      await request.json(),
      getStorageAdapter(),
    );
    return Response.json(result, { headers: workbenchFileHeaders });
  } catch (error) {
    return workbenchFileError(error);
  }
}
