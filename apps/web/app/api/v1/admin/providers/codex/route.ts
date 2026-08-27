import {
  DataAccessError,
  getCodexAuthorization,
  getCodexProviderGrant,
  getCodexProviderStatus,
  isPlatformAdmin,
} from '@allrice/database';

import { getRequestContext } from '../../../../../../lib/identity/session';
import { skillHubErrorResponse } from '../../../../../../lib/skillhub/responses';

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
    return Response.json({ provider, grant, authorization });
  } catch (error) {
    return skillHubErrorResponse(error);
  }
}
