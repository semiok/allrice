import {
  DEntryNativeDiscoverySchema,
  DEntrySelectionInputSchema,
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
import { dEntryClientMount } from '../../../../../lib/d-entry/admission';
import { dEntryErrorResponse } from '../../../../../lib/d-entry/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const context = await authenticateNativeRequest(request);
    const selection = DEntrySelectionInputSchema.parse(await request.json());
    const input = await currentNativeRequest(request, selection, context);
    const response = await requestDEntryWorker(input, 'native-owner');
    const safe = await readDEntryWorkerJson(response, (value) =>
      DEntryNativeDiscoverySchema.strip().parse(value),
    );
    if (!sameDEntryIdentity(safe.identity, input.identity))
      throw new DataAccessError('authorization_denied');
    return Response.json(
      {
        mount: dEntryClientMount(safe.identity, '4.0', safe.bindingRef),
        controlReady: safe.controlReady,
      },
      {
        headers: { 'cache-control': 'private, no-store' },
      },
    );
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
