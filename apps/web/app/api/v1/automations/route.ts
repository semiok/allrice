import {
  DataAccessError,
  createAutomation,
  listAutomations,
} from '@allrice/database';

import { getRequestContext } from '../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../lib/storage/responses';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId =
      new URL(request.url).searchParams.get('workspaceId') ?? undefined;
    return Response.json(await listAutomations(context, workspaceId));
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      { automation: await createAutomation(context, await request.json()) },
      { status: 201 },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
