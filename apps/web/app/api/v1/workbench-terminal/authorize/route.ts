import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
import {
  DataAccessError,
  resolveWorkbenchTerminalTarget,
} from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { bridgeErrorResponse } from '../../../../../lib/bridge/responses';
import { readAdminJson } from '../../../../../lib/tenant-administration/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const TargetInput = z
  .object({
    workspaceId: UuidSchema,
    sessionId: UuidSchema,
    deviceId: UuidSchema,
    grantId: UuidSchema,
  })
  .strict();
const headers = { 'Cache-Control': 'private, no-store, max-age=0' };
/** Also used by the fixed loopback WS adapter, retaining the exact portal and
 * cookie authentication of every other tenant API. This endpoint starts no PTY. */
export async function POST(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const result = await resolveWorkbenchTerminalTarget(
      context,
      TargetInput.parse(await readAdminJson(request, 2048)),
    );
    return Response.json(result, { headers });
  } catch (error) {
    const response = bridgeErrorResponse(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
