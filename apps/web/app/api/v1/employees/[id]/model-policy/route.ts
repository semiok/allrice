import {
  DataAccessError,
  getEmployeeModelPolicy,
  getPlatformModelSettings,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function workspaceId(request: Request, contextWorkspaceId: string | null) {
  const selected =
    new URL(request.url).searchParams.get('workspaceId') ?? contextWorkspaceId;
  if (!selected) throw new DataAccessError('not_found');
  return selected;
}

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    return Response.json({
      policy: await getEmployeeModelPolicy({
        context,
        workspaceId: workspaceId(request, context.workspaceId),
        employeeId: id,
      }),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    await getPlatformModelSettings(context);
    return Response.json(
      {
        error: {
          code: 'PLATFORM_MODELS_REQUIRED',
          message: '模型由平台统一配置，请前往模型与用量。',
        },
      },
      { status: 410 },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
