import { DataAccessError, sendChatMessage } from '@allrice/database';

import { getRequestContext } from '../../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';

export const runtime = 'nodejs';

function event(name: string, data: unknown) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    const result = await sendChatMessage(
      context,
      workspaceId,
      id,
      await request.json(),
    );
    const encoder = new TextEncoder();
    const response = result.assistantMessage.content.text;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(event('message.accepted', result.userMessage)),
        );
        for (let index = 0; index < response.length; index += 48) {
          controller.enqueue(
            encoder.encode(
              event('assistant.delta', {
                text: response.slice(index, index + 48),
              }),
            ),
          );
        }
        controller.enqueue(
          encoder.encode(event('assistant.completed', result.assistantMessage)),
        );
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
