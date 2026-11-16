import { AddEmployeeModuleInputSchema, UuidSchema } from '@allrice/contracts';
import {
  DataAccessError,
  addEmployeeInstanceModule,
  listEmployeeInstanceModules,
} from '@allrice/database';
import { requireRequestContext } from '../../../../../../lib/identity/session';
import { brandMediaErrorResponse } from '../../../../../../lib/brand-media/responses';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
type Route = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Route) {
  try {
    const context = await requireRequestContext(request);
    const workspaceId =
      new URL(request.url).searchParams.get('workspaceId') ??
      context.workspaceId;
    return Response.json(
      await listEmployeeInstanceModules(context, {
        workspaceId,
        instanceId: UuidSchema.parse((await params).id).toLowerCase(),
      }),
      { headers },
    );
  } catch (error) {
    return brandMediaErrorResponse(error);
  }
}
export async function POST(request: Request, { params }: Route) {
  try {
    const context = await requireRequestContext(request);
    const input = AddEmployeeModuleInputSchema.parse(await request.json());
    if (input.instanceId !== UuidSchema.parse((await params).id).toLowerCase())
      throw new DataAccessError('authorization_denied');
    return Response.json(await addEmployeeInstanceModule(context, input), {
      headers,
    });
  } catch (error) {
    return brandMediaErrorResponse(error);
  }
}
