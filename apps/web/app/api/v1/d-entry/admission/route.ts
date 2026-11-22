import { requireRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { DataAccessError } from '@allrice/database';
import { DEntrySelectionInputSchema } from '@allrice/contracts';
import { resolveDEntryIdentity } from '../../../../../lib/d-entry/identity';
import { resolveDEntryAdmission } from '../../../../../lib/d-entry/admission';
import {
  DEntryDependencyUnavailable,
  readDEntryReleasePolicy,
} from '../../../../../lib/d-entry/release-policy';
import { dEntryErrorResponse } from '../../../../../lib/d-entry/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await requireRequestContext(request);
    const selection = DEntrySelectionInputSchema.parse(await request.json());
    // Establish owner/employee authority before consulting release routing.
    await resolveDEntryIdentity(context, selection, 'execute');
    const policy = await readDEntryReleasePolicy(context, request.signal);
    const admission = await resolveDEntryAdmission(context, selection, policy);
    // MET-266 has not published an HTTP/WS/profile route. An admission fact
    // alone must never be presented as a mounted or send-capable native Client.
    if (admission.executionGeneration === '4.0')
      throw new DEntryDependencyUnavailable('native-route');
    return Response.json(admission, {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
