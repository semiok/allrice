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
  getDatabase,
  listRunEvents,
  subscribeChatFlowWakeups,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { chatFlowRealtimeEnabled } from '../../../../../../lib/chatflow/rollout';
import { incrementChatFlowMetric } from '../../../../../../lib/chatflow/metrics';
import { createChatFlowWaiter } from '../../../../../../lib/chatflow/waiter';

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
  preferNotify: boolean;
}) {
  const encoder = new TextEncoder();
  let sequence = input.afterSequence;
  let pending = input.initialEvents;
  let lastHeartbeat = Date.now();
  const waiter = createChatFlowWaiter();
  let unsubscribe: (() => void) | null = null;
  let notifyActive = false;
  try {
    if (input.preferNotify) {
      try {
        unsubscribe = await subscribeChatFlowWakeups(
          getDatabase(),
          input.runId,
          () => {
            incrementChatFlowMetric('wakeups');
            waiter.signal();
          },
        );
        notifyActive = true;
        incrementChatFlowMetric('postgresNotifyConnections');
      } catch (error) {
        incrementChatFlowMetric('notifyFallbacks');
        console.error(
          '[ChatFlow] PostgreSQL notification subscription failed',
          {
            runId: input.runId,
            message: error instanceof Error ? error.message : 'unknown error',
          },
        );
      }
    }
    if (!notifyActive) incrementChatFlowMetric('pollingConnections');
    while (!input.request.signal.aborted) {
      for (const event of pending) {
        input.controller.enqueue(encoder.encode(encodedEvent(event)));
        sequence = event.sequence;
        incrementChatFlowMetric('eventsDelivered');
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
      if (notifyActive) {
        const wakeup = await waiter.wait(5_000, input.request.signal);
        if (wakeup === 'aborted') break;
        if (wakeup === 'timeout') incrementChatFlowMetric('safetyPolls');
      } else {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
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
  } finally {
    unsubscribe?.();
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
    const harness = initialEvents
      .map((event) =>
        event.payload && typeof event.payload === 'object'
          ? (event.payload as { source?: unknown }).source
          : null,
      )
      .find((source) => source === 'codex' || source === 'dsh');
    const preferNotify = chatFlowRealtimeEnabled({
      organizationId: context.organizationId,
      workspaceId,
      harness: harness === 'codex' || harness === 'dsh' ? harness : null,
    });
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
          preferNotify,
        });
      },
    });
    incrementChatFlowMetric('connections');
    if (lastEventId) incrementChatFlowMetric('reconnects');
    return new Response(stream, {
      headers: {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
        'x-allrice-chatflow-version': '2',
        'x-allrice-chatflow-event-contract': 'run-event-v1',
        'x-allrice-chatflow-transport': preferNotify
          ? 'postgres-notify'
          : 'polling',
      },
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
