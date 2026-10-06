import { makeHealthResponse } from '@allrice/contracts';
import {
  pingDatabase,
  readServiceBuildIdentity,
  readDevMaintenance,
} from '@allrice/database';
import { releaseHeaders } from '../../../../lib/release-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    await pingDatabase();
    const identity = await readServiceBuildIdentity('web');
    const maintenance = await readDevMaintenance();
    return Response.json(
      {
        ...makeHealthResponse('web', 'ready'),
        ...(identity ? { identity } : {}),
        ...(maintenance ? { maintenance } : {}),
      },
      {
        headers: { ...releaseHeaders(), 'Cache-Control': 'no-store' },
      },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown readiness error';
    return Response.json(makeHealthResponse('web', 'not_ready', message), {
      status: 503,
      headers: { ...releaseHeaders(), 'Cache-Control': 'no-store' },
    });
  }
}
