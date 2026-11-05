import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
import {
  DataAccessError,
  PersonalSkillError,
  managePersonalSkill,
} from '@allrice/database';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { employeeHubErrorResponse } from '../../../../../../../lib/employeehub/responses';
import { apiProblem } from '../../../../../../../lib/api-problem';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
const inputSchema = z
  .object({
    workspaceId: UuidSchema,
    expectedRevision: z.number().int().positive(),
    requestId: UuidSchema,
  })
  .strict();

/** The employee's "uninstall" action disables precisely this binding. The
 * owner's library and every other employee retain their existing versions. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; installationId: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const input = inputSchema.parse(await request.json());
    const target = await params;
    const instanceId = UuidSchema.parse(target.id);
    const installationId = UuidSchema.parse(target.installationId);
    const skill = await managePersonalSkill(context, {
      ...input,
      instanceId,
      installationId,
      operation: 'disable',
    });
    const binding = skill.bindings.find(
      (item) => item.instanceId === instanceId,
    );
    if (!binding || binding.enabled) throw new PersonalSkillError('conflict');
    return Response.json(
      {
        receipt: {
          operation: 'disable',
          scope: 'instance',
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          instanceId,
          installationId,
          revision: skill.revision,
          versionId: skill.versionId,
          binding,
        },
      },
      { headers },
    );
  } catch (error) {
    const response =
      error instanceof PersonalSkillError
        ? apiProblem({
            status: error.code === 'unavailable' ? 404 : 409,
            code:
              error.code === 'unavailable'
                ? 'RESOURCE_NOT_FOUND'
                : 'VERSION_CONFLICT',
            message: '技能状态或权限已变化，请刷新后重试。',
            retryable: false,
          })
        : employeeHubErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) =>
      response.headers.set(key, value),
    );
    return response;
  }
}
