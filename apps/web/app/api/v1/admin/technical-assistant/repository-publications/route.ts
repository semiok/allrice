import {
  createPlatformRepositoryAction,
  listPlatformRepositoryPublications,
  findPlatformRepositoryPublication,
} from '@allrice/database';
import {
  RepositoryPublicationSchema,
  RepositoryPublicationRequestSchema,
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
      id = new URL(request.url).searchParams.get('requestId');
    return Response.json(
      id
        ? {
            publication: RepositoryPublicationSchema.nullable().parse(
              await findPlatformRepositoryPublication(context, id),
            ),
          }
        : RepositoryPublicationSchema.array()
            .max(50)
            .parse(await listPlatformRepositoryPublications(context)),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    if (
      !sameOriginBrowserWrite(request) ||
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return new Response(null, { status: 403, headers });
    const context = await requirePlatformAdminContext(request);
    if (platformAutonomyPaused()) return deferredPlatformActionResponse();
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400, headers });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1024) {
          await reader.cancel();
          return new Response(null, { status: 413, headers });
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return new Response(null, { status: 400, headers });
    }
    return Response.json(
      RepositoryPublicationSchema.parse(
        await createPlatformRepositoryAction(
          context,
          RepositoryPublicationRequestSchema.parse(raw),
        ),
      ),
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
