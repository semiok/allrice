import { DataAccessError, recallRagChunks } from '@allrice/database';

import { getRequestContext } from '../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../lib/storage/responses';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const results = await recallRagChunks(context, await request.json());
    return Response.json({ results });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
