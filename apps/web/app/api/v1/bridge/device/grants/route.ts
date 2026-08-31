import { createBridgeFolderGrant } from '@allrice/database';

import { getBridgeDeviceToken } from '../../../../../../lib/bridge/request';
import { bridgeErrorResponse } from '../../../../../../lib/bridge/responses';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    return Response.json(
      {
        grant: await createBridgeFolderGrant(
          getBridgeDeviceToken(request),
          await request.json(),
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
