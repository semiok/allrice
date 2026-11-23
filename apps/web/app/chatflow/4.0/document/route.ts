import { DEntrySelectionInputSchema } from '@allrice/contracts';
import { requireRequestContext } from '../../../../lib/identity/session';
import {
  apiErrorResponse,
  apiProblem,
} from '../../../../lib/api-error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** This is the real product document boundary, deliberately non-executable
 * until the original history identity, principal/snapshot/follow and complete
 * graph/events/assets carrier are delivered. No test producer can install one. */
export async function GET(request: Request) {
  let response: Response;
  try {
    await requireRequestContext(request);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => query.getAll(key).length !== 1))
      throw new SyntaxError('Entry selectors must be unique');
    DEntrySelectionInputSchema.parse(Object.fromEntries(query));
    // 88ea has no resolveDEntryIdentity(..., 'history') export. The existing
    // panel authority requires rollout and cannot substitute for cold history.
    // Missing real principal or unified graph authority must never emit HTML,
    // replay build-Host owner:true, or start a VM to obtain a viewer.
    response = apiProblem({
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: '当前入口暂不可用',
      retryable: false,
    });
  } catch (error) {
    response = apiErrorResponse(error);
  }
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
