import {
  createPlatformRepairTask,
  listPlatformRepairTasks,
  findPlatformRepairTask,
} from '@allrice/database';
import {
  RepairTaskSchema,
  CreateRepairTaskSchema,
} from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import {
  platformAutonomyPaused,
  deferredPlatformActionResponse,
} from '../../../../../../lib/execution/platform-autonomy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    const context = await requirePlatformAdminContext(request),
      requestId = new URL(request.url).searchParams.get('requestId');
    return Response.json(
      requestId
        ? {
            task: RepairTaskSchema.nullable().parse(
              await findPlatformRepairTask(context, requestId),
            ),
          }
        : RepairTaskSchema.array()
            .max(20)
            .parse(await listPlatformRepairTasks(context)),
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
    if (platformAutonomyPaused()) return deferredPlatformActionResponse();
    const text = await request.text();
    if (text.length > 1000) return new Response(null, { status: 413, headers });
    return Response.json(
      RepairTaskSchema.parse(
        await createPlatformRepairTask(
          context,
          CreateRepairTaskSchema.parse(JSON.parse(text)),
        ),
      ),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
