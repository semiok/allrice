import { readWorkbenchFileCatalog } from '@allrice/database';
import {
  workbenchFileContext,
  workbenchFileError,
  workbenchFileHeaders,
} from '../../../../../lib/workbench-files';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Read-marker identities only; no private text, filenames or source excerpts. */
export async function GET(request: Request) {
  try {
    const context = await workbenchFileContext(request);
    const files = await readWorkbenchFileCatalog(context, {
      workspaceId: context.workspaceId,
    });
    return Response.json(
      {
        fileIds: files.files.map((file) => file.objectId),
      },
      { headers: workbenchFileHeaders },
    );
  } catch (error) {
    return workbenchFileError(error);
  }
}
