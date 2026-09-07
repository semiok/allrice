import { handleRuntimeBridgeOperation } from '../../../../../../../../lib/bridge/operation-runtime';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRuntimeBridgeOperation(request, 'heartbeat', (await params).id);
}
