import {
  formatSseCursor,
  isTerminalRunStatus,
  parseSseCursor,
  type RequestContext,
  type RunEvent,
} from '@allrice/contracts';
import {
  DataAccessError,
  QueueError,
  getRun,
  listRunEvents,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function encodedEvent(event: RunEvent) {
  return [
    `id: ${formatSseCursor({ runId: event.runId, sequence: event.sequence })}`,
    'event: run-event',
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}

async function streamEvents(input: {
  controller: ReadableStreamDefaultController<Uint8Array>;
  request: Request;
  context: RequestContext;
  workspaceId: string;
  runId: string;
  initialEvents: RunEvent[];
  afterSequence: number;
}) {
  const encoder = new TextEncoder();
  let sequence = input.afterSequence;
  let pending = input.initialEvents;
  let lastHeartbeat = Date.now();
  try {
    while (!input.request.signal.aborted) {
      for (const event of pending) {
        input.controller.enqueue(encoder.encode(encodedEvent(event)));
        sequence = event.sequence;
      }
      const run = await getRun(input.context, input.workspaceId, input.runId);
      const nextEvents = await listRunEvents(
        input.context,
        input.workspaceId,
        input.runId,
        sequence,
      );
      if (nextEvents.length > 0) {
        pending = nextEvents;
        continue;
      }
      if (isTerminalRunStatus(run.status)) break;
      if (Date.now() - lastHeartbeat >= 15_000) {
        input.controller.enqueue(encoder.encode(': heartbeat\n\n'));
        lastHeartbeat = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
      pending = await listRunEvents(
        input.context,
        input.workspaceId,
        input.runId,
        sequence,
      );
    }
    input.controller.close();
  } catch (error) {
    if (!input.request.signal.aborted) {
      input.controller.error(error);
    }
  }
}

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    await getRun(context, workspaceId, id);
    const lastEventId = request.headers.get('last-event-id');
    let afterSequence = -1;
    if (lastEventId) {
      try {
        const cursor = parseSseCursor(lastEventId);
        if (cursor.runId !== id) throw new QueueError('cursor_invalid');
        afterSequence = cursor.sequence;
      } catch (error) {
        if (error instanceof QueueError) throw error;
        throw new QueueError('cursor_invalid');
      }
    }
    const initialEvents = await listRunEvents(
      context,
      workspaceId,
      id,
      afterSequence,
    );
    if (
      new URL(request.url).searchParams.get('format') === 'json' ||
      request.headers.get('accept')?.includes('application/json')
    ) {
      return Response.json({ events: initialEvents });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void streamEvents({
          controller,
          request,
          context,
          workspaceId,
          runId: id,
          initialEvents,
          afterSequence,
        });
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
    return executionErrorResponse(error);
  }
}
