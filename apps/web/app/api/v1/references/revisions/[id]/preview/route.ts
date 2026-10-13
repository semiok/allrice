import { getReferenceFile } from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import {
  referenceContext,
  referenceError,
  referenceHeaders,
} from '../../../../../../../lib/reference-library';
import { readStaticArtifactPreview } from '../../../../../../../lib/runtime/static-artifact-preview';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await referenceContext(request),
      { id } = await route.params,
      params = new URL(request.url).searchParams,
      workspaceId = UuidSchema.parse(params.get('workspaceId'));
    const file = await getReferenceFile(context, workspaceId, id);
    const preview = await readStaticArtifactPreview(
      {
        object: file.object,
        kind: 'file',
        version: { fileName: file.fileName },
      },
      {
        offset: Number(params.get('offset') ?? 1),
        source: params.get('source') === '1',
        signal: request.signal,
      },
    );
    await getReferenceFile(context, workspaceId, id);
    return Response.json(preview, { headers: referenceHeaders });
  } catch (error) {
    return referenceError(error);
  }
}
