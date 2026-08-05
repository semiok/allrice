import { DataAccessError, getCodexProviderStatus } from '@allrice/database';

import { getRequestContext } from '../../../../../../lib/identity/session';
import { skillHubErrorResponse } from '../../../../../../lib/skillhub/responses';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context || context.actor.type !== 'user') {
      throw new DataAccessError('authentication_required');
    }
    if (
      !context.memberships.some(
        (membership) =>
          membership.active &&
          membership.organizationId === context.organizationId &&
          membership.role === 'admin',
      )
    ) {
      throw new DataAccessError('authorization_denied');
    }
    return Response.json({ provider: await getCodexProviderStatus() });
  } catch (error) {
    return skillHubErrorResponse(error);
  }
}
