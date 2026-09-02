import { BridgeControlInputSchema } from '@allrice/contracts';

import { apiProblem } from '../../../../../lib/api-error-response';
import { controlSnowBridge } from '../../../../../lib/bridge/snow-ssh-control';
import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(reason: unknown) {
  console.error('Snow Bridge control failed', {
    message: reason instanceof Error ? reason.message : 'Unknown failure',
  });
  return apiProblem({
    status: 502,
    code: 'DEPENDENCY_UNAVAILABLE',
    message: '无法连接 Snow Mac，请检查 SSH 或电脑在线状态',
    retryable: true,
  });
}

export async function GET(request: Request) {
  try {
    await requirePlatformAdminContext(request);
  } catch (reason) {
    return executionErrorResponse(reason);
  }
  try {
    return Response.json(await controlSnowBridge('status'));
  } catch (reason) {
    return errorResponse(reason);
  }
}

export async function POST(request: Request) {
  try {
    await requirePlatformAdminContext(request);
  } catch (reason) {
    return executionErrorResponse(reason);
  }
  let action: 'start' | 'stop';
  try {
    action = BridgeControlInputSchema.parse(await request.json()).action;
  } catch (reason) {
    return reason instanceof SyntaxError
      ? apiProblem({
          status: 400,
          code: 'VALIDATION_FAILED',
          message: 'Bridge control request must contain valid JSON',
          retryable: false,
        })
      : executionErrorResponse(reason);
  }
  try {
    return Response.json(await controlSnowBridge(action));
  } catch (reason) {
    return errorResponse(reason);
  }
}
