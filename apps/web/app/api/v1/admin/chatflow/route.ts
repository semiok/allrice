import { chatFlowMetricsSnapshot } from '../../../../../lib/chatflow/metrics';
import { readChatFlowRealtimePolicy } from '../../../../../lib/chatflow/rollout';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../lib/execution/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requirePlatformAdminContext(request);
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
