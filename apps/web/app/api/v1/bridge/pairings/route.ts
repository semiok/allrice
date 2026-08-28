import { DataAccessError, createBridgePairing } from '@allrice/database';

import { bridgeErrorResponse } from '../../../../../lib/bridge/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      { pairing: await createBridgePairing(context, await request.json()) },
      { status: 201 },
    );
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
