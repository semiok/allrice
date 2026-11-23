import { createDEntryHistoryRouteHandlers } from '../../../../../lib/d-entry/history-authority';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return createDEntryHistoryRouteHandlers().history(request);
}
