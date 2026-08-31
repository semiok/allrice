import { revokeCurrentBridgeDevice } from '@allrice/database';

import { getBridgeDeviceToken } from '../../../../../../lib/bridge/request';
import { bridgeErrorResponse } from '../../../../../../lib/bridge/responses';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    await revokeCurrentBridgeDevice(getBridgeDeviceToken(request));
    return new Response(null, { status: 204 });
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
