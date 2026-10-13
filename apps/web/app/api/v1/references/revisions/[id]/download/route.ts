import { getReferenceFile } from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import {
  referenceContext,
  referenceError,
  referenceHeaders,
} from '../../../../../../../lib/reference-library';
import { getStorageAdapter } from '../../../../../../../lib/storage/runtime';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await referenceContext(request),
      { id } = await route.params,
      workspaceId = UuidSchema.parse(
        new URL(request.url).searchParams.get('workspaceId'),
      );
    const file = await getReferenceFile(context, workspaceId, id),
      stream = await getStorageAdapter().get(file.object);
    try {
      await getReferenceFile(context, workspaceId, id);
    } catch (error) {
      await stream.cancel();
      throw error;
    }
    return new Response(stream, {
      headers: {
        ...referenceHeaders,
        'Content-Type': file.object.mediaType,
        'Content-Length': String(file.object.sizeBytes),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName.replace(/[\r\n/\\]/g, '-'))}`,
      },
    });
  } catch (error) {
    return referenceError(error);
  }
}
