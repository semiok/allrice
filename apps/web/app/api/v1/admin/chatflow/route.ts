import { DataAccessError } from '@allrice/database';

import { chatFlowMetricsSnapshot } from '../../../../../lib/chatflow/metrics';
import { readChatFlowRealtimePolicy } from '../../../../../lib/chatflow/rollout';
import { getRequestContext } from '../../../../../lib/identity/session';
import { executionErrorResponse } from '../../../../../lib/execution/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context || context.actor.type !== 'user') {
      throw new DataAccessError('authentication_required');
    }
    const admin = context.memberships.some(
      (membership) =>
        membership.active &&
        membership.userId === context.actor.id &&
        membership.organizationId === context.organizationId &&
        membership.role === 'admin',
    );
    if (!admin) throw new DataAccessError('authorization_denied');
    return Response.json({
      runtime: 'AllRice ChatFlow',
      durableSource: 'postgres-run-events',
      realtime: {
        activeTransport: 'postgres-notify',
        fallbackTransport: 'polling',
        futureTransports: ['redis-streams', 'nats'],
        policy: readChatFlowRealtimePolicy(),
      },
      metrics: chatFlowMetricsSnapshot(),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
