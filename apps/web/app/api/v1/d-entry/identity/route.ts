import {
  DEntryIdentityResultSchema,
  DEntrySelectionInputSchema,
} from '@allrice/contracts';
import { requireRequestContext } from '../../../../../lib/identity/session';
import { resolveDEntryIdentity } from '../../../../../lib/d-entry/identity';
import { dEntryErrorResponse } from '../../../../../lib/d-entry/responses';
import { apiProblem } from '../../../../../lib/api-error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const context = await requireRequestContext(request);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => query.getAll(key).length !== 1))
      return apiProblem({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: 'Entry selectors must be unique',
      });
    const selection = DEntrySelectionInputSchema.parse(
      Object.fromEntries(query),
    );
    const identity = await resolveDEntryIdentity(context, selection, 'history');
    return Response.json(DEntryIdentityResultSchema.parse({ identity }), {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return dEntryErrorResponse(error);
  }
}
