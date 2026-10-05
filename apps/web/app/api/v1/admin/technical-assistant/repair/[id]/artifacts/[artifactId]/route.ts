import {
  getPlatformRepairArtifact,
  readArtifactBytes,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../../../../../lib/execution/responses';
import { getStorageAdapter } from '../../../../../../../../../lib/storage/runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string; artifactId: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    const context = await requirePlatformAdminContext(request),
      p = await params;
    const artifact = await getPlatformRepairArtifact(
      context,
      p.id,
      p.artifactId,
    );
    const bytes = await readArtifactBytes(
      getStorageAdapter(),
      artifact.object,
      2_000_000,
    );
    await getPlatformRepairArtifact(context, p.id, p.artifactId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': artifact.object.mediaType,
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.version.fileName)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
