import { z } from 'zod';
import { UuidSchema, brandContentTemplateKeys } from '@allrice/contracts';
import {
  DataAccessError,
  listWorkflowPackages,
  registerBrandContentReminder,
} from '@allrice/database';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { brandContentErrorResponse } from '../../../../../../../lib/brand-content/responses';

const InputSchema = z
  .object({
    workspaceId: UuidSchema,
    instanceId: UuidSchema,
    brandId: UuidSchema,
    planId: UuidSchema,
    expectedRevision: z.number().int().positive(),
    requestId: UuidSchema,
  })
  .strict();
export const runtime = 'nodejs';

/** Only the authenticated owner registers a reminder. The browser cannot pick
 * a past package or move this plan to another employee/session. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const input = InputSchema.parse(await request.json());
    if (input.instanceId !== (await params).id)
      throw new DataAccessError('authorization_denied');
    const catalog = await listWorkflowPackages(context, {
      workspaceId: input.workspaceId,
      instanceId: input.instanceId,
      sceneId: null,
    });
    const selected = catalog.find(
      (row) =>
        row.package.manifest.templateKey === brandContentTemplateKeys.handoff &&
        row.binding?.enabled &&
        row.binding.workflowRevisionId === row.package.workflow.id,
    );
    if (!selected) throw new DataAccessError('not_found');
    const receipt = await registerBrandContentReminder(context, input, {
      workflow: {
        workflowRevisionId: selected.package.workflow.id,
        packageDigest: selected.package.checksum,
      },
    });
    return Response.json(receipt, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return brandContentErrorResponse(error);
  }
}
