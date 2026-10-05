import {
  createPlatformQualityCheck,
  listPlatformQualityChecks,
} from '@allrice/database';
import { QualityCheckSchema } from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    return Response.json(
      QualityCheckSchema.array()
        .max(20)
        .parse(
          await listPlatformQualityChecks(
            await requirePlatformAdminContext(request),
          ),
        ),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      return new Response(null, { status: 403, headers });
    const context = await requirePlatformAdminContext(request);
    const text = await request.text();
    if (text.length > 1000) return new Response(null, { status: 413, headers });
    return Response.json(
      QualityCheckSchema.parse(
        await createPlatformQualityCheck(context, JSON.parse(text)),
      ),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
