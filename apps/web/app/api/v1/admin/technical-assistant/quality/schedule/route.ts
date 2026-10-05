import {
  getPlatformQualitySchedule,
  updatePlatformQualitySchedule,
  deletePlatformQualitySchedule,
} from '@allrice/database';
import { QualityScheduleViewSchema } from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    return Response.json(
      QualityScheduleViewSchema.parse(
        await getPlatformQualitySchedule(
          await requirePlatformAdminContext(request),
        ),
      ),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
async function write(request: Request, remove: boolean) {
  try {
    if (!sameOriginBrowserWrite(request))
      return new Response(null, { status: 403, headers });
    const context = await requirePlatformAdminContext(request),
      text = await request.text();
    if (text.length > 1000) return new Response(null, { status: 413, headers });
    const result = await (
      remove ? deletePlatformQualitySchedule : updatePlatformQualitySchedule
    )(context, JSON.parse(text));
    return Response.json(QualityScheduleViewSchema.parse(result), { headers });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export const PUT = (request: Request) => write(request, false);
export const DELETE = (request: Request) => write(request, true);
