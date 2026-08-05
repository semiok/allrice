import { SignFileInputSchema } from '@allrice/contracts';
import {
  DataAccessError,
  getStoredFile,
  saveStorageGrant,
} from '@allrice/database';

import { getRequestContext } from '../../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';
import { getSignedAccessService } from '../../../../../../lib/storage/runtime';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context || context.actor.type !== 'user') {
      throw new DataAccessError('authentication_required');
    }
    const { id } = await route.params;
    const input = SignFileInputSchema.parse(await request.json());
    const file = await getStoredFile(context, id);
    const issued = getSignedAccessService().issue({
      object: file.object,
      subjectId: context.actor.id,
      operation: 'read',
      lifetimeSeconds: input.lifetimeSeconds,
    });
    await saveStorageGrant(context, issued.grant);
    const url = new URL(`/api/v1/files/${id}`, request.url);
    url.searchParams.set('token', issued.token);
    return Response.json({
      url: `${url.pathname}${url.search}`,
      expiresAt: issued.grant.expiresAt,
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
