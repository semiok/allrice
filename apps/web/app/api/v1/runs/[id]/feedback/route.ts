import {
  DataAccessError,
  EmployeeQualityError,
  recordRunFeedback,
} from '@allrice/database';

import { apiProblem } from '../../../../../../lib/api-error-response';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { requireRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireRequestContext(request);
    const { id } = await route.params;
    return Response.json({
      feedback: await recordRunFeedback(context, id, await request.json()),
    });
  } catch (error) {
    if (error instanceof DataAccessError) {
      return executionErrorResponse(error);
    }
    if (error instanceof EmployeeQualityError) {
      if (error.code === 'not_found') {
        return apiProblem({
          status: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: 'Run feedback target not found',
        });
      }
      return apiProblem({
        status: 409,
        code:
          error.code === 'default_protected'
            ? 'DEFAULT_EMPLOYEE_PROTECTED'
            : 'CONFLICT',
        message: 'Run feedback conflicts with the current employee state',
      });
    }
    return executionErrorResponse(error);
  }
}
