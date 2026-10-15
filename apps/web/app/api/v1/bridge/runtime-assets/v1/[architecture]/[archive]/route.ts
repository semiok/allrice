import {
  openManagedPythonPayload,
  managedRuntimeAssetResponse,
} from '../../../../../../../../lib/bridge/runtime-assets';

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
  return managedRuntimeAssetResponse(request, asset);
}
export const GET = download;
export const HEAD = download;
