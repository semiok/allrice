import { BrandContentActionSchema } from '@allrice/contracts';
import {
  DataAccessError,
  getBrandContentWorkspace,
  listWorkflowPackages,
  mutateBrandContent,
} from '@allrice/database';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { brandContentErrorResponse } from '../../../../../../lib/brand-content/responses';

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = new URL(request.url).searchParams;
    const workspaceId = query.get('workspaceId') ?? context.workspaceId;
    if (!workspaceId) throw new DataAccessError('not_found');
    if (query.get('catalogOnly') === '1') {
      const entries = await listWorkflowPackages(context, {
        workspaceId,
        instanceId: (await params).id,
      });
      return Response.json(
        {
          packages: entries
            .filter(
              (entry) =>
                entry.binding?.enabled &&
                entry.binding.workflowRevisionId ===
                  entry.package.workflow.id &&
                entry.syncStatus !== 'source_unavailable',
            )
            .map((entry) => entry.package),
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    return Response.json(
      await getBrandContentWorkspace(context, {
        workspaceId,
        instanceId: (await params).id,
        ...(query.get('brandId') ? { brandId: query.get('brandId')! } : {}),
      }),
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return brandContentErrorResponse(error);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const action = BrandContentActionSchema.parse(await request.json());
    if (action.instanceId !== (await params).id)
      throw new DataAccessError('authorization_denied');
    return Response.json(
      { receipt: await mutateBrandContent(context, action) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return brandContentErrorResponse(error);
  }
}
