import { DEntryNativeRpcRequestSchema } from '@allrice/contracts';
import {
  authenticateNativeRequest,
  currentNativeRequest,
} from '../../../../../lib/d-entry/native-request';
import { requestDEntryWorker } from '../../../../../lib/d-entry/native-worker';
import { dEntryErrorResponse } from '../../../../../lib/d-entry/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const context = await authenticateNativeRequest(request);
    const { selection, endpoint, payload } = DEntryNativeRpcRequestSchema.parse(
      await request.json(),
    );
    const input = await currentNativeRequest(request, selection, context);
    const response = await requestDEntryWorker(input, 'native-rpc', {
      endpoint,
      payload,
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type':
          response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
