import {
  DataAccessError,
  EmployeeQualityError,
  createEmployeeEvalSuite,
  getEmployeeQualityDashboard,
  recordEmployeeEvalRun,
  updateEmployeeRelease,
} from '@allrice/database';

import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(error: unknown) {
  if (error instanceof DataAccessError) {
    const status = error.code === 'authentication_required' ? 401 : 403;
    return Response.json({ error: { code: error.code } }, { status });
  }
  if (error instanceof EmployeeQualityError) {
    const status = error.code === 'not_found' ? 404 : 409;
    return Response.json({ error: { code: error.code } }, { status });
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return Response.json(
      { error: { code: 'invalid_request' } },
      { status: 400 },
    );
  }
  console.error('[employee-quality] request failed', {
    error: error instanceof Error ? error.message : 'unknown',
  });
  return Response.json({ error: { code: 'internal_error' } }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
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
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const body = (await request.json()) as {
      action?: string;
      payload?: unknown;
    };
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
    return Response.json(
      { error: { code: 'invalid_action' } },
      { status: 400 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
