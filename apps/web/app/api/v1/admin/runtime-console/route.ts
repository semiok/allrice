import { listDshRuntimeInventory } from '@allrice/database';

import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requirePlatformAdminContext(request);
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
