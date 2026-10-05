import {
  createPlatformTechnicalTask,
  listPlatformTechnicalTasks,
} from '@allrice/database';
import { TechnicalTaskSchema } from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    const context = await requirePlatformAdminContext(request);
    return Response.json(
      TechnicalTaskSchema.array()
        .max(20)
        .parse(await listPlatformTechnicalTasks(context)),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      return new Response(null, { status: 403 });
    const context = await requirePlatformAdminContext(request);
    const text = await request.text();
    if (text.length > 6000) return new Response(null, { status: 413 });
    return Response.json(
      await createPlatformTechnicalTask(context, JSON.parse(text)),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
