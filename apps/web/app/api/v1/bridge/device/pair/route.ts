import { pairBridgeDevice } from '@allrice/database';

import { bridgeErrorResponse } from '../../../../../../lib/bridge/responses';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    return Response.json(await pairBridgeDevice(await request.json()), {
      status: 201,
    });
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
