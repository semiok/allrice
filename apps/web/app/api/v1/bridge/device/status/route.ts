import { bridgeDeviceStatus } from '@allrice/database';

import { getBridgeDeviceToken } from '../../../../../../lib/bridge/request';
import { bridgeErrorResponse } from '../../../../../../lib/bridge/responses';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    return Response.json(
      await bridgeDeviceStatus(getBridgeDeviceToken(request)),
    );
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
