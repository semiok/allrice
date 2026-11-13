import {
  listReferencePublications,
  publishReference,
  referencePublicationOptions,
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
    const params = new URL(request.url).searchParams;
    const workspaceId = UuidSchema.parse(
      params.get('workspaceId') ?? context.workspaceId,
    );
    return Response.json(
      {
        references: await listReferencePublications(
          context,
          workspaceId,
          params.has('sourceId')
            ? UuidSchema.parse(params.get('sourceId'))
            : undefined,
        ),
        options: await referencePublicationOptions(context, workspaceId),
      },
      { headers: referenceHeaders },
    );
  } catch (error) {
    return referenceError(error);
  }
}

export async function POST(request: Request) {
  try {
    const saved = await publishReference(
      await referenceContext(request, true),
      await request.json(),
      getStorageAdapter(),
    );
    return Response.json(saved, { status: 201, headers: referenceHeaders });
  } catch (error) {
    return referenceError(error);
  }
}
