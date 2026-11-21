import {
  DEntryNativeResourceFactsSchema,
  DEntrySelectionInputSchema,
  UuidSchema,
} from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import { z } from 'zod';
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
  })
  .strict();

/** Explicit 4.0 creation only. History and discovery never create/wake a root.
 * Native id/preset/path/owner/receipt are not accepted from the browser. */
export async function POST(request: Request) {
  try {
    const context = await authenticateNativeRequest(request);
    const { selection } = schema.parse(await request.json());
    const input = await currentNativeRequest(request, selection, context);
    const response = await requestDEntryWorker(input, 'native-root');
    const root = await readDEntryWorkerJson(response, (value) =>
      DEntryNativeResourceFactsSchema.parse(value),
    );
    if (
      root.organizationId !== input.identity.organizationId ||
      root.personId !== input.identity.personId ||
      root.employeeInstanceId !== input.identity.employeeInstanceId ||
      root.threadId !== input.identity.threadId ||
      root.nativeSessionId !== root.rootNativeSessionId ||
      root.parentNativeSessionId !== null
    )
      throw new DataAccessError('authorization_denied');
    return Response.json(root, {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
