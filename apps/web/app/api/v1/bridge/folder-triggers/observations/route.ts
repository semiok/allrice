import { recordFolderTriggerObservation } from '@allrice/database';
import { getBridgeDeviceToken } from '../../../../../../lib/bridge/request';
import { bridgeErrorResponse } from '../../../../../../lib/bridge/responses';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    return Response.json(
      await recordFolderTriggerObservation(
        getBridgeDeviceToken(request),
        await request.json(),
      ),
    );
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
