import {
  DataAccessError,
  listPlatformEmployeeHistoryDirectory,
  readPlatformEmployeeHistory,
  readPlatformEmployeeHistoryRevision,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { executionErrorResponse } from '../execution/responses';
import { isRequestValidationError } from '../api-error-response';

const headers = { 'Cache-Control': 'private, no-store' };
export async function platformEmployeeHistoryHttp(
  request: Request,
  employeeId?: string,
  revisionId?: string,
) {
  try {
    const context = await requirePlatformAdminContext(request);
    const query = new URL(request.url).searchParams;
    const result = employeeId
      ? revisionId
        ? {
            revision: await readPlatformEmployeeHistoryRevision(
              context,
              employeeId,
              revisionId,
            ),
          }
        : await readPlatformEmployeeHistory(context, employeeId, {
            before: query.get('before') ?? undefined,
          })
      : await listPlatformEmployeeHistoryDirectory(context, {
          after: query.get('after') ?? undefined,
          search: query.get('search') ?? undefined,
        });
    return Response.json(result, { headers });
  } catch (error) {
    if (isRequestValidationError(error))
      return Response.json(
        { code: 'INVALID_REQUEST' },
        { status: 400, headers },
      );
    if (error instanceof DataAccessError)
      return Response.json(
        { code: error.code.toUpperCase() },
        {
          status:
            error.code === 'not_found'
              ? 404
              : error.code === 'authentication_required'
                ? 401
                : 403,
          headers,
        },
      );
    return executionErrorResponse(error);
  }
}
