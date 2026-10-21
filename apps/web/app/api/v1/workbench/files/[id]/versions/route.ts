import { UuidSchema } from '@allrice/contracts';
import {
  workbenchFileContext,
  workbenchFileError,
  workbenchFileHeaders,
} from '../../../../../../../lib/workbench-files';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { listWorkbenchFileVersions } from '@allrice/database';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await workbenchFileContext(request),
      { id } = await route.params;
    return Response.json(
      {
        versions: await listWorkbenchFileVersions(
          context,
          UuidSchema.parse(id),
        ),
      },
      { headers: workbenchFileHeaders },
    );
  } catch (error) {
    return workbenchFileError(error);
  }
}
