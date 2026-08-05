import { ExecuteSkillInputSchema } from '@allrice/contracts';
import { DataAccessError, enqueueSkillRun } from '@allrice/database';

import { getRequestContext } from '../../../../../lib/identity/session';
import { skillHubErrorResponse } from '../../../../../lib/skillhub/responses';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const input = ExecuteSkillInputSchema.parse(await request.json());
    const result = await enqueueSkillRun(context, input);
    return Response.json(
      { run: result.run, idempotentReplay: !result.created },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return skillHubErrorResponse(error);
  }
}
