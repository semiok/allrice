import { BrandMediaUserCommandSchema, UuidSchema } from '@allrice/contracts';
import {
  DataAccessError,
  commandBrandMediaUser,
  readBrandMedia,
} from '@allrice/database';
import { requireRequestContext } from '../../../../../../lib/identity/session';
import { brandMediaErrorResponse } from '../../../../../../lib/brand-media/responses';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
type Route = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Route) {
  try {
    const context = await requireRequestContext(request);
    const { cursor, ...query } = Object.fromEntries(
      new URL(request.url).searchParams,
    );
    const instanceId = UuidSchema.parse((await params).id).toLowerCase();
    if (query.instanceId && query.instanceId.toLowerCase() !== instanceId)
      throw new DataAccessError('authorization_denied');
    return Response.json(
      await readBrandMedia(context, {
        ...query,
        workspaceId: query.workspaceId ?? context.workspaceId,
        instanceId,
        ...(cursor ? { cursor: JSON.parse(cursor) } : {}),
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
    const command = BrandMediaUserCommandSchema.parse(await request.json());
    if (
      command.instanceId !== UuidSchema.parse((await params).id).toLowerCase()
    )
      throw new DataAccessError('authorization_denied');
    return Response.json(await commandBrandMediaUser(context, command), {
      headers,
    });
  } catch (error) {
    return brandMediaErrorResponse(error);
  }
}
