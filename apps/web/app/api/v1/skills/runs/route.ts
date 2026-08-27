import { ExecuteSkillInputSchema } from '@allrice/contracts';
import { DataAccessError, SkillHubError } from '@allrice/database';

import { getRequestContext } from '../../../../../lib/identity/session';
import { skillHubErrorResponse } from '../../../../../lib/skillhub/responses';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    ExecuteSkillInputSchema.parse(await request.json());
    throw new SkillHubError('conversation_required');
  } catch (error) {
    return skillHubErrorResponse(error);
  }
}
