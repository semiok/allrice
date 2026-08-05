import { makeHealthResponse } from '@allrice/contracts';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(makeHealthResponse('web', 'live'));
}
