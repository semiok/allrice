import {
  completeReferenceUpload,
  listReferenceRevisions,
  prepareReferenceUpload,
  referenceLibraryOptions,
} from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import {
  referenceContext,
  referenceError,
  referenceHeaders,
} from '../../../../lib/reference-library';
import { getStorageAdapter } from '../../../../lib/storage/runtime';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const context = await referenceContext(request),
      params = new URL(request.url).searchParams,
      workspaceId = UuidSchema.parse(
        params.get('workspaceId') ?? context.workspaceId,
      );
    return Response.json(
      {
        references: await listReferenceRevisions(
          context,
          workspaceId,
          params.get('sourceId')
            ? UuidSchema.parse(params.get('sourceId'))
            : undefined,
        ),
        options: await referenceLibraryOptions(context, workspaceId),
      },
      { headers: referenceHeaders },
    );
  } catch (error) {
    return referenceError(error);
  }
}
export async function POST(request: Request) {
  try {
    const context = await referenceContext(request),
      input = await request.json(),
      prepared = await prepareReferenceUpload(context, input);
    if (!prepared.alreadyReady) {
      await getStorageAdapter().put(
        prepared.object,
        new Blob([new Uint8Array(prepared.bytes)]).stream(),
      );
      await completeReferenceUpload(
        context,
        input.workspaceId,
        prepared.revisionId,
      );
    }
    return Response.json(
      { sourceId: prepared.sourceId, revisionId: prepared.revisionId },
      { status: 201, headers: referenceHeaders },
    );
  } catch (error) {
    return referenceError(error);
  }
}
