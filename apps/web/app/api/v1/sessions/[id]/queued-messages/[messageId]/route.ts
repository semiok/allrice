import {
  ArtifactReviewError,
  DataAccessError,
  updateQueuedMessage,
} from '@allrice/database';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { employeeHubErrorResponse } from '../../../../../../../lib/employeehub/responses';
import { readAdminJson } from '../../../../../../../lib/tenant-administration/http';

export const runtime = 'nodejs';
export async function POST(
  request: Request,
  route: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      return Response.json(
        { error: { message: '请求来源不匹配，请刷新页面。' } },
        { status: 403 },
      );
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id, messageId } = await route.params;
    await updateQueuedMessage(
      context,
      workspaceId,
      id,
      messageId,
      await readAdminJson(request, 2048),
    );
    return Response.json(
      { ok: true },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof ArtifactReviewError) {
      const messages: Record<string, string> = {
        queued_message_started: '这条消息已开始处理，不能再从队列修改。',
        queued_attachments_require_turn: '含附件的消息需要作为下一轮任务处理。',
        input_turn_changed: '当前回合已结束或发生变化，消息仍保留在队列中。',
      };
      return Response.json(
        {
          error: {
            code: error.code,
            message: messages[error.code] ?? '排队消息不可用，请刷新后重试。',
          },
        },
        { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    return employeeHubErrorResponse(error);
  }
}
