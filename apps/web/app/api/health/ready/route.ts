import { makeHealthResponse } from '@allrice/contracts';
import { pingDatabase } from '@allrice/database';
import { releaseHeaders } from '../../../../lib/release-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    await pingDatabase();
    return Response.json(makeHealthResponse('web', 'ready'), {
      headers: { ...releaseHeaders(), 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown readiness error';
    return Response.json(makeHealthResponse('web', 'not_ready', message), {
      status: 503,
      headers: { ...releaseHeaders(), 'Cache-Control': 'no-store' },
    });
  }
}
