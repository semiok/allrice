import { DataAccessError, installSkill } from '@allrice/database';

import { getRequestContext } from '../../../../../lib/identity/session';
import { skillHubErrorResponse } from '../../../../../lib/skillhub/responses';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      { installation: await installSkill(context, await request.json()) },
      { status: 201 },
    );
  } catch (error) {
    return skillHubErrorResponse(error);
  }
}
