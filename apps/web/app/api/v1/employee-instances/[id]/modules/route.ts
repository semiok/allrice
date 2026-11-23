import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { AddEmployeeModuleInputSchema, UuidSchema } from '@allrice/contracts';
import {
  DataAccessError,
  addEmployeeInstanceModule,
  listEmployeeInstanceModules,
  readApplicationBuiltinModules,
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
    const scope = {
      workspaceId,
      instanceId: UuidSchema.parse((await params).id).toLowerCase(),
    };
    await listEmployeeInstanceModules(context, scope);
    request.signal.throwIfAborted();
    // App builtins are separate from the existing brand module bindings.
    const applicationModules = await readApplicationBuiltinModules('web');
    request.signal.throwIfAborted();
    const current = await listEmployeeInstanceModules(context, scope);
    request.signal.throwIfAborted();
    return Response.json({ ...current, applicationModules }, { headers });
  } catch (error) {
    return brandMediaErrorResponse(error);
  }
}
export async function POST(request: Request, { params }: Route) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
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
