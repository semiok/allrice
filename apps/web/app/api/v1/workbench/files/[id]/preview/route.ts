import { UuidSchema } from '@allrice/contracts';
import {
  workbenchFileContext,
  workbenchFileError,
  workbenchFileHeaders,
} from '../../../../../../../lib/workbench-files';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { readWorkbenchFile } from '@allrice/database';
import { readStaticArtifactPreview } from '../../../../../../../lib/runtime/static-artifact-preview';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await workbenchFileContext(request),
      { id } = await route.params,
      params = new URL(request.url).searchParams;
    const file = await readWorkbenchFile(context, UuidSchema.parse(id));
    const preview = await readStaticArtifactPreview(
      {
        object: file.object,
        kind: 'file',
        version: { fileName: file.row.file_name },
      },
      {
        offset: Number(params.get('offset') ?? 1),
        source: params.get('source') === '1',
        signal: request.signal,
      },
    );
    await readWorkbenchFile(context, id);
    return Response.json(preview, { headers: workbenchFileHeaders });
  } catch (error) {
    return workbenchFileError(error);
  }
}
