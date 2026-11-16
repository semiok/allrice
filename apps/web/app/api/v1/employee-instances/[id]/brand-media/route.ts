import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import {
  BrandMediaUserCommandSchema,
  BrandMediaGenerateInputSchema,
  UuidSchema,
} from '@allrice/contracts';
import {
  DataAccessError,
  commandBrandMediaUser,
  readBrandMedia,
  generateBrandMedia,
  readBrandMediaRuns,
  readBrandMediaUsage,
} from '@allrice/database';
import { requireRequestContext } from '../../../../../../lib/identity/session';
import { brandMediaErrorResponse } from '../../../../../../lib/brand-media/responses';

import { getStorageAdapter } from '../../../../../../lib/storage/runtime';

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
    if (query.view === 'runs' || query.view === 'help') {
      const scope = {
        workspaceId: query.workspaceId ?? context.workspaceId,
        instanceId,
      };
      return Response.json(
        query.view === 'help'
          ? await readBrandMediaUsage(context, scope)
          : await readBrandMediaRuns(context, scope, getStorageAdapter()),
        { headers },
      );
    }
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
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await requireRequestContext(request);
    const raw = await request.json();
    const generating =
      raw?.operation === 'candidates' || raw?.operation === 'article';
    const command = generating
      ? BrandMediaGenerateInputSchema.parse(raw)
      : BrandMediaUserCommandSchema.parse(raw);
    if (
      command.instanceId !== UuidSchema.parse((await params).id).toLowerCase()
    )
      throw new DataAccessError('authorization_denied');
    return Response.json(
      await (generating
        ? generateBrandMedia(context, command)
        : commandBrandMediaUser(context, command)),
      {
        headers,
      },
    );
  } catch (error) {
    return brandMediaErrorResponse(error);
  }
}
