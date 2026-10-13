import {
  referenceLibraryOptions,
  saveArtifactReference,
} from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import {
  referenceContext,
  referenceError,
  referenceHeaders,
} from '../../../../../lib/reference-library';
import { getStorageAdapter } from '../../../../../lib/storage/runtime';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const context = await referenceContext(request);
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId') ??
        context.workspaceId,
    );
    return Response.json(await referenceLibraryOptions(context, workspaceId), {
      headers: referenceHeaders,
    });
  } catch (error) {
    return referenceError(error);
  }
}
export async function POST(request: Request) {
  try {
    const context = await referenceContext(request);
    const saved = await saveArtifactReference(
      context,
      await request.json(),
      getStorageAdapter(),
    );
    return Response.json(saved, { status: 201, headers: referenceHeaders });
  } catch (error) {
    return referenceError(error);
  }
}
