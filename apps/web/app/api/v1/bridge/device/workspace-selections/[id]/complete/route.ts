import { completeBridgeWorkspaceSelection } from '@allrice/database';

import { getBridgeDeviceToken } from '../../../../../../../../lib/bridge/request';
import { bridgeErrorResponse } from '../../../../../../../../lib/bridge/responses';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await completeBridgeWorkspaceSelection(
        getBridgeDeviceToken(request),
        (await route.params).id,
        await request.json(),
      ),
    );
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
