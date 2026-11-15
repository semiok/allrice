import { UuidSchema } from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import {
  workbenchFileContext,
  workbenchFileError,
} from '../../../../../../lib/workbench-files';
export const runtime = 'nodejs';
export async function PATCH(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    await workbenchFileContext(request, true);
    UuidSchema.parse((await route.params).id);
    throw new DataAccessError('not_found');
  } catch (error) {
    return workbenchFileError(error);
  }
}
