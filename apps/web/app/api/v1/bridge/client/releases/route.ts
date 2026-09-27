import { DataAccessError } from '@allrice/database';
import { bridgeClientReleases } from '../../../../../../lib/bridge/client-releases';
import { bridgeErrorResponse } from '../../../../../../lib/bridge/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let response: Response;
  try {
    if (!(await getRequestContext(request)))
      throw new DataAccessError('authentication_required');
    response = Response.json({ releases: await bridgeClientReleases() });
  } catch (error) {
    response = bridgeErrorResponse(error);
  }
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}
