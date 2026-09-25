import { UserPreferencesInputSchema } from '@allrice/contracts';
import {
  DataAccessError,
  getUserPreferences,
  updateUserPreferences,
} from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

async function handle(request: Request, update: boolean) {
  try {
    const context = await getRequestContext(request);
    if (!context || context.actor.type !== 'user')
      return Response.json(
        { error: { message: '请先登录' } },
        { status: 401, headers },
      );
    const input = update
      ? UserPreferencesInputSchema.safeParse(
          await request.json().catch(() => null),
        )
      : null;
    if (input && !input.success)
      return Response.json(
        { error: { message: '偏好设置格式不正确' } },
        { status: 400, headers },
      );
    const preferences = input?.success
      ? await updateUserPreferences(context, input.data)
      : await getUserPreferences(context);
    return Response.json(
      { viewerId: context.actor.id, preferences },
      { headers },
    );
  } catch (error) {
    return Response.json(
      { error: { message: '个人偏好暂时无法保存或读取，请重试' } },
      {
        status: error instanceof DataAccessError ? 403 : 503,
        headers,
      },
    );
  }
}
export const GET = (request: Request) => handle(request, false);
export const PATCH = (request: Request) => handle(request, true);
