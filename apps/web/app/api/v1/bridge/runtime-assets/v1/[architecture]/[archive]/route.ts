import { Readable } from 'node:stream';
import { openManagedPythonPayload } from '../../../../../../../../lib/bridge/runtime-assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Route = { params: Promise<{ architecture: string; archive: string }> };

async function download(request: Request, route: Route) {
  const { architecture, archive } = await route.params;
  const asset = await openManagedPythonPayload(architecture, archive);
  if (!asset)
    return new Response(null, {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  const headers = {
    'Content-Type': 'application/gzip',
    'Content-Length': String(asset.release.archive.sizeBytes),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'X-Allrice-Checksum': asset.release.archive.sha256,
    ETag: `"${asset.release.archive.sha256}"`,
  };
  if (request.method === 'HEAD') {
    await asset.handle.close();
    return new Response(null, { headers });
  }
  return new Response(
    Readable.toWeb(
      asset.handle.createReadStream({ start: 0, autoClose: true }),
    ) as ReadableStream<Uint8Array>,
    { headers },
  );
}
export const GET = download;
export const HEAD = download;
