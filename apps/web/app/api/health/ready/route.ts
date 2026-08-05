import { makeHealthResponse } from '@allrice/contracts';
import { pingDatabase } from '@allrice/database';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    await pingDatabase();
    return Response.json(makeHealthResponse('web', 'ready'));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown readiness error';
    return Response.json(makeHealthResponse('web', 'not_ready', message), {
      status: 503,
    });
  }
}
