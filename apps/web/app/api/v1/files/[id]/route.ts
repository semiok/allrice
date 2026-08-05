import {
  DataAccessError,
  completeStorageDelete,
  prepareStorageDelete,
  resolveStorageGrant,
} from '@allrice/database';

import { getRequestContext } from '../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../lib/storage/responses';
import {
  getSignedAccessService,
  getStorageAdapter,
} from '../../../../../lib/storage/runtime';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await route.params;
    const token = new URL(request.url).searchParams.get('token');
    if (!token) throw new DataAccessError('grant_invalid');
    const grant = getSignedAccessService().verify(token, {
      objectId: id,
      operation: 'read',
    });
    const file = await resolveStorageGrant(grant);
    return new Response(await getStorageAdapter().get(file.object), {
      headers: {
        'cache-control': 'private, no-store',
        'content-length': String(file.object.sizeBytes),
        'content-type': file.object.mediaType,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    const file = await prepareStorageDelete(context, id);
    await getStorageAdapter().delete(file.object);
    await completeStorageDelete(context, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
