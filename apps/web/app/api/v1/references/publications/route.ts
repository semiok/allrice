import {
  listReferencePublications,
  queryReferencePublications,
  DataAccessError,
  ReferenceRuntimeError,
  publishReference,
  referencePublicationOptions,
} from '@allrice/database';
import {
  ReferencePublicationQuerySchema,
  UuidSchema,
} from '@allrice/contracts';
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
    const queryMode = ['query', 'category', 'cursor', 'limit'].some((key) =>
      params.has(key),
    );
    if (queryMode && workspaceId !== context.workspaceId)
      throw new DataAccessError('authorization_denied');
    const page = queryMode
      ? await queryReferencePublications(
          context,
          ReferencePublicationQuerySchema.parse({
            ...(params.has('query') ? { query: params.get('query') } : {}),
            ...(params.has('category')
              ? { category: params.get('category') }
              : {}),
            ...(params.has('sourceId')
              ? { sourceId: params.get('sourceId') }
              : {}),
            ...(params.has('limit')
              ? { limit: Number(params.get('limit')) }
              : {}),
            ...(params.has('cursor')
              ? { cursor: JSON.parse(params.get('cursor')!) }
              : {}),
          }),
        )
      : null;
    return Response.json(
      {
        viewerId: context.actor.id,
        ...(page ?? {
          references: await listReferencePublications(
            context,
            workspaceId,
            params.has('sourceId')
              ? UuidSchema.parse(params.get('sourceId'))
              : undefined,
          ),
        }),
        options: await referencePublicationOptions(context, workspaceId),
      },
      { headers: referenceHeaders },
    );
  } catch (error) {
    if (error instanceof ReferenceRuntimeError)
      return referenceError(new DataAccessError('not_found'));
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
