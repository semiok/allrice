import {
  DEntryNativePrewarmInputSchema,
  DEntryNativePrewarmResultSchema,
  sameDEntryIdentity,
} from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import {
  authenticateNativeRequest,
  currentNativeRequest,
} from '../../../../../lib/d-entry/native-request';
import {
  requestDEntryWorker,
  readDEntryWorkerJson,
} from '../../../../../lib/d-entry/native-worker';
import { dEntryErrorResponse } from '../../../../../lib/d-entry/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Best effort page/first-input prewarm; no prompt or readiness capability. */
export async function POST(request: Request) {
  try {
    const context = await authenticateNativeRequest(request);
    const { selection, trigger } = DEntryNativePrewarmInputSchema.parse(
      await request.json(),
    );
    const input = await currentNativeRequest(request, selection, context);
    const response = await requestDEntryWorker(input, 'native-prewarm', {
      trigger,
    });
    const result = await readDEntryWorkerJson(response, (value) =>
      DEntryNativePrewarmResultSchema.parse(value),
    );
    if (
      !sameDEntryIdentity(input.identity, result.identity) ||
      result.trigger !== trigger
    )
      throw new DataAccessError('authorization_denied');
    return new Response(null, {
      status: 204,
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
