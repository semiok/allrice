import {
  getMaintenanceGithubBot,
  updateMaintenanceGithubBot,
} from '@allrice/database';
import { MaintenanceGithubBotSchema } from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    return Response.json(
      MaintenanceGithubBotSchema.parse(
        await getMaintenanceGithubBot(
          await requirePlatformAdminContext(request),
        ),
      ),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function PUT(request: Request) {
  try {
    if (
      !sameOriginBrowserWrite(request) ||
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return new Response(null, { status: 403, headers });
    const context = await requirePlatformAdminContext(request),
      reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400, headers });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) {
          await reader.cancel();
          return new Response(null, { status: 413, headers });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Response.json(
      MaintenanceGithubBotSchema.parse(
        await updateMaintenanceGithubBot(
          context,
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        ),
      ),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
