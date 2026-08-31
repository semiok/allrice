import { DataAccessError, listDshRuntimeInventory } from '@allrice/database';

import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
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
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
    return Response.json({
      console: {
        name: 'AllRice Runtime Console',
        authority: 'ChatFlow 3.0',
        harness: 'DSH',
        mode: 'read-only',
        source: 'allrice_conversation_runtimes',
      },
      runtimes: await listDshRuntimeInventory(limit),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
