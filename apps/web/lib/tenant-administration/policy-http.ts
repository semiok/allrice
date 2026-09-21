import { TenantPolicyChangeSchema, UuidSchema } from '@allrice/contracts';
import {
  getPlatformRuntimePolicyControls,
  setPlatformRuntimePolicyControls,
  RuntimePolicyError,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { executionErrorResponse } from '../execution/responses';
import { apiProblem } from '../api-error-response';
import { readAdminJson } from './http';
export async function tenantPolicyHttp(
  request: Request,
  organizationId: string,
) {
  try {
    const context = await requirePlatformAdminContext(request);
    if (request.method === 'GET')
      return Response.json(
        await getPlatformRuntimePolicyControls(
          context,
          organizationId,
          UuidSchema.parse(
            new URL(request.url).searchParams.get('workspaceId'),
          ),
        ),
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    if (!sameOriginBrowserWrite(request))
      return apiProblem({
        status: 403,
        code: 'AUTHORIZATION_DENIED',
        message: '仅允许同源策略修改',
      });
    const input = TenantPolicyChangeSchema.parse(
      await readAdminJson(request, 32000),
    );
    const controls = await setPlatformRuntimePolicyControls(
      context,
      { organizationId, workspaceId: input.workspaceId },
      input.controls,
      input.expectedVersion,
      input.reason,
    );
    return Response.json(
      {
        organizationId,
        workspaceId: input.workspaceId,
        version: controls.version,
        controls,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof RuntimePolicyError)
      return apiProblem({
        status: error.code === 'policy_version_conflict' ? 409 : 400,
        code:
          error.code === 'policy_version_conflict'
            ? 'CONFLICT'
            : 'VALIDATION_FAILED',
        message:
          error.code === 'policy_version_conflict'
            ? '策略已变化，请刷新并重新确认。'
            : '策略无效，请检查动作与规则。',
        retryable: false,
      });
    if (error instanceof SyntaxError)
      return apiProblem({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: '请求格式或大小不正确。',
      });
    return executionErrorResponse(error);
  }
}
