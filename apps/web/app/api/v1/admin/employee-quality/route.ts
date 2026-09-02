import { EmployeeQualityActionInputSchema } from '@allrice/contracts';
import {
  DataAccessError,
  EmployeeQualityError,
  createEmployeeEvalSuite,
  getEmployeeQualityDashboard,
  recordEmployeeEvalRun,
  updateEmployeeRelease,
} from '@allrice/database';

import {
  apiProblem,
  isRequestValidationError,
} from '../../../../../lib/api-error-response';
import { requireRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(error: unknown) {
  if (error instanceof DataAccessError) {
    const status = error.code === 'authentication_required' ? 401 : 403;
    return apiProblem({
      status,
      code: status === 401 ? 'AUTHENTICATION_REQUIRED' : 'AUTHORIZATION_DENIED',
      message: status === 401 ? 'Authentication required' : 'Access denied',
    });
  }
  if (error instanceof EmployeeQualityError) {
    const status = error.code === 'not_found' ? 404 : 409;
    return apiProblem({
      status,
      code:
        error.code === 'not_found'
          ? 'RESOURCE_NOT_FOUND'
          : error.code === 'default_protected'
            ? 'DEFAULT_EMPLOYEE_PROTECTED'
            : 'CONFLICT',
      message:
        error.code === 'not_found'
          ? 'Employee quality resource not found'
          : 'Employee quality state conflicts with this action',
    });
  }
  if (isRequestValidationError(error)) {
    return apiProblem({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'Employee quality request validation failed',
    });
  }
  console.error('[employee-quality] request failed', {
    error: error instanceof Error ? error.message : 'unknown',
  });
  return apiProblem({
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Employee quality request failed',
    retryable: true,
  });
}

export async function GET(request: Request) {
  try {
    const context = await requireRequestContext(request);
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    return Response.json({
      quality: await getEmployeeQualityDashboard(
        context,
        workspaceId ?? undefined,
      ),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requireRequestContext(request);
    const body = EmployeeQualityActionInputSchema.parse(await request.json());
    if (body.action === 'create_eval_suite') {
      return Response.json({
        suite: await createEmployeeEvalSuite(context, body.payload),
      });
    }
    if (body.action === 'record_eval_run') {
      return Response.json({
        evaluation: await recordEmployeeEvalRun(context, body.payload),
      });
    }
    if (body.action === 'update_release') {
      return Response.json({
        quality: await updateEmployeeRelease(context, body.payload),
      });
    }
    return apiProblem({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'Unsupported employee quality action',
    });
  } catch (error) {
    return errorResponse(error);
  }
}
