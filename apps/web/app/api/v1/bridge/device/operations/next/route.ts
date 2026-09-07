import { handleRuntimeBridgeOperation } from '../../../../../../../lib/bridge/operation-runtime';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return handleRuntimeBridgeOperation(request, 'next');
}
