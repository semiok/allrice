import { heartbeatBridgeDevice } from '@allrice/database';

import { getBridgeDeviceToken } from '../../../../../../lib/bridge/request';
import { bridgeErrorResponse } from '../../../../../../lib/bridge/responses';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const input = await request.json().catch(() => undefined);
    return Response.json({
      device: await heartbeatBridgeDevice(getBridgeDeviceToken(request), input),
    });
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
