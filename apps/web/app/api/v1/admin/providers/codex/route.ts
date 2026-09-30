import {
  DataAccessError,
  getCodexAuthorization,
  getCodexProviderGrant,
  getCodexProviderStatus,
  isPlatformAdmin,
  listCodexSubscriptions,
  selectCodexSubscription,
} from '@allrice/database';

import { getRequestContext } from '../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { apiErrorResponse } from '../../../../../../lib/api-error-response';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context || context.actor.type !== 'user') {
      throw new DataAccessError('authentication_required');
    }
    if (!(await isPlatformAdmin(context))) {
      throw new DataAccessError('authorization_denied');
    }
    const [provider, grant, authorization] = await Promise.all([
      getCodexProviderStatus(),
      getCodexProviderGrant(context),
      getCodexAuthorization(context),
    ]);
    const subscriptions = await Promise.all(
      (await listCodexSubscriptions(context)).map(async (account) => ({
        ...account,
        provider: await getCodexProviderStatus(account.slot),
        authorization: await getCodexAuthorization(
          context,
          undefined,
          account.slot,
        ),
      })),
    );
    return Response.json(
      { provider, grant, authorization, subscriptions },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      await selectCodexSubscription(context, await request.json()),
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
