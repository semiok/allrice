import {
  PublishPlatformEmployeeInputSchema,
  UpdatePlatformEmployeeInputSchema,
  UuidSchema,
} from '@allrice/contracts';
import {
  compilePlatformEmployee,
  getPlatformEmployee,
  publishPlatformEmployee,
  savePlatformEmployeeDraft,
  reviewEmployeePublication,
  readPlatformSkillForAdministration,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { executionErrorResponse } from '../execution/responses';
import { apiProblem } from '../api-error-response';
import { readAdminJson } from './http';
export async function employeeAdministrationHttp(
  request: Request,
  id: string,
  action: 'review' | 'publish' | 'save' | 'skill',
) {
  try {
    const context = await requirePlatformAdminContext(request);
    if (action === 'skill')
      return Response.json(
        { skill: await readPlatformSkillForAdministration(context, id) },
        {
          headers: {
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        },
      );
    if (!sameOriginBrowserWrite(request))
      return apiProblem({
        status: 403,
        code: 'AUTHORIZATION_DENIED',
        message: '仅允许同源管理操作。',
      });
    const body = await readAdminJson(request, 200000);
    if (action === 'save') {
      const input = UpdatePlatformEmployeeInputSchema.parse(body);
      UuidSchema.parse(input.expectedRevisionId);
      const saved = await savePlatformEmployeeDraft(
        id,
        input,
        context.actor.id,
      );
      const validation = await compilePlatformEmployee(
        id,
        context.actor.id,
        saved!.currentDraft!.id,
      );
      return Response.json({
        employee: await getPlatformEmployee(id),
        validation,
      });
    }
    const input = PublishPlatformEmployeeInputSchema.parse(body);
    if (action === 'review')
      return Response.json(
        await reviewEmployeePublication(context, id, input.workspaceIds),
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    if (
      !input.expectedRevisionId ||
      !input.expectedPackageChecksum ||
      !Object.hasOwn(input, 'expectedPublishedRevisionId') ||
      !input.policyVersions
    )
      return apiProblem({
        status: 409,
        code: 'CONFLICT',
        message: '请先预检并确认当前版本、目标和策略，再发布。',
        retryable: false,
      });
    return Response.json(
      await publishPlatformEmployee(id, input, context.actor.id, context),
    );
  } catch (error) {
    if (error instanceof SyntaxError)
      return apiProblem({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: '请求格式或大小不正确。',
      });
    return executionErrorResponse(error);
  }
}
