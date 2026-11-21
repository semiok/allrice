import {
  DEntryNativeResourceFactsSchema,
  DEntrySelectionInputSchema,
} from '@allrice/contracts';
import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
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
const schema = z
  .object({
    selection: DEntrySelectionInputSchema.extend({ threadId: UuidSchema }),
    nativeSessionId: z.string().min(1),
  })
  .strict();
export async function POST(request: Request) {
  try {
    const context = await authenticateNativeRequest(request);
    const { selection, nativeSessionId } = schema.parse(await request.json());
    const input = await currentNativeRequest(request, selection, context);
    const response = await requestDEntryWorker(input, 'native-resource', {
      nativeSessionId,
    });
    const resource = await readDEntryWorkerJson(response, (value) =>
      DEntryNativeResourceFactsSchema.parse(value),
    );
    if (
      resource.organizationId !== input.identity.organizationId ||
      resource.personId !== input.identity.personId ||
      resource.employeeInstanceId !== input.identity.employeeInstanceId ||
      resource.threadId !== input.identity.threadId ||
      resource.nativeSessionId !== nativeSessionId
    )
      throw new DataAccessError('authorization_denied');
    return Response.json(resource, {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
