import {
  DataAccessError,
  listDshRuntimeEventTimeline,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  route: { params: Promise<{ sessionId: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context || context.actor.type !== 'user') {
      throw new DataAccessError('authentication_required');
    }
    const platformAdmin = context.memberships.some(
      (membership) =>
        membership.active &&
        membership.userId === context.actor.id &&
        membership.organizationId === context.organizationId &&
        membership.role === 'admin',
    );
    if (!platformAdmin) throw new DataAccessError('authorization_denied');
    const { sessionId } = await route.params;
    return Response.json({
      timeline: await listDshRuntimeEventTimeline(sessionId),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
