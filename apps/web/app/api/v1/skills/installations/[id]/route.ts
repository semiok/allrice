import { DataAccessError, updateSkillInstallation } from '@allrice/database';

import { getRequestContext } from '../../../../../../lib/identity/session';
import { skillHubErrorResponse } from '../../../../../../lib/skillhub/responses';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    return Response.json({
      installation: await updateSkillInstallation(
        context,
        id,
        await request.json(),
      ),
    });
  } catch (error) {
    return skillHubErrorResponse(error);
  }
}
