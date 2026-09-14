import {
  DataAccessError,
  sendChatMessage,
  ArtifactReviewError,
  QueueError,
  AssistantRuntimeError,
} from '@allrice/database';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';

import { getRequestContext } from '../../../../../../lib/identity/session';
import { employeeHubErrorResponse } from '../../../../../../lib/employeehub/responses';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      return Response.json(
        { error: { message: '请求来源不匹配，请刷新页面。' } },
        { status: 403 },
      );
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 300_000) {
          await reader.cancel();
          return new Response(null, { status: 413 });
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    const result = await sendChatMessage(context, workspaceId, id, input);
    return Response.json(result, {
      status: result.created ? 202 : 200,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    if (error instanceof AssistantRuntimeError)
      return Response.json(
        {
          error: {
            code: error.code,
            message:
              '当前任务未获准使用助手。请关闭助手选项，或联系管理员检查员工权限。',
          },
        },
        { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
      );
    if (error instanceof ArtifactReviewError || error instanceof QueueError) {
      const messages: Record<string, string> = {
        input_turn_changed:
          '原回合已结束或发生变化，输入未执行。请刷新后重新选择发送方式。',
        input_id_conflict: '相同提交编号的内容发生变化，请刷新后重试。',
        version_conflict: '工件已有新版本，请审查新版本后再提交。',
        review_already_sent: '此版本的确认或意见已经发送，请查看运行记录。',
        submitted_feedback_required: '请先保存并提交本批意见。',
      };
      return Response.json(
        {
          error: {
            code: error.code,
            message:
              messages[error.code] ?? '交互不可用，请刷新当前版本或检查权限。',
          },
        },
        { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    return employeeHubErrorResponse(error);
  }
}
